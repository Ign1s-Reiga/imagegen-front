"""Tests for the training runner: `python -m unittest discover src-tauri/runner`.

The end-to-end tests drive a fake trainer through the real supervisor, so
they need a POSIX host (process groups, flock) and are skipped elsewhere.
They test the runner's control flow only, not training.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import imagegen_train_runner as runner  # noqa: E402

HASH = "a" * 64


def request(**train):
    return {
        "version": 1,
        "jobId": str(uuid.uuid4()),
        "trainer": runner.TRAINER_ID,
        "model": {"repo": "Qwen/Qwen-Image-2.1", "revision": "main"},
        "dataset": {
            "files": [{"name": "0001.png", "sha256": HASH, "caption": 'tkn person; rm -rf / "$(whoami)"'}],
            "instancePrompt": "photo of tkn person",
        },
        "train": {
            "resolution": 1024, "buckets": True, "rank": 16, "alpha": 16, "learningRate": 1e-4,
            "batchSize": 1, "gradAccum": 4, "maxSteps": 500, "seed": 0, "checkpointSteps": 100,
            **train,
        },
        "validation": {"prompts": ["photo of tkn person"], "seeds": [1, 2], "everySteps": 100},
    }


class CheckRequest(unittest.TestCase):
    def test_accepts_the_preset(self):
        checked = runner.check_request(request())
        self.assertEqual(checked["train"]["rank"], 16)
        self.assertTrue(checked["train"]["use8bitAdam"])

    def test_refuses_bad_values(self):
        for train in [
            {"resolution": 1000},
            {"rank": 0},
            {"rank": True},
            {"learningRate": "1e-4"},
            {"maxSteps": 1.5},
            {"precision": "fp8"},
            {"loraLayers": "to_q; rm -rf /"},
        ]:
            with self.assertRaises(runner.RequestError, msg=train):
                runner.check_request(request(**train))

    def test_refuses_bad_dataset_names(self):
        for name in ["../x.png", "a.png", "0001.png/../../etc", "0001.jpg"]:
            req = request()
            req["dataset"]["files"][0]["name"] = name
            with self.assertRaises(runner.RequestError, msg=name):
                runner.check_request(req)

    def test_validation_interval_follows_checkpoints(self):
        req = request()
        req["validation"]["everySteps"] = 150
        with self.assertRaises(runner.RequestError):
            runner.check_request(req)

    def test_job_ids_are_uuids(self):
        ws = Path("/w")
        for bad in ["..", "../etc", "a/b", "", "X" * 36]:
            with self.assertRaises(runner.RequestError):
                runner.job_dir(ws, bad)


class TrainArgv(unittest.TestCase):
    paths = {"python": "/v/python", "script": "/s.py", "model": "/m", "dataset": "/j/dataset",
             "output": "/j/output", "logs": "/j/tb", "bnb": "/j/bnb.json"}

    def test_every_value_is_one_argument(self):
        argv = runner.build_train_argv(runner.check_request(request()), self.paths)
        self.assertIn("--instance_prompt=photo of tkn person", argv)
        self.assertIn("--use_aspect_ratio_buckets", argv)
        self.assertIn("--rank=16", argv)
        self.assertIn("--skip_final_inference", argv)
        # Captions stay in metadata.jsonl, never on the command line.
        self.assertFalse(any("whoami" in a for a in argv))

    def test_options(self):
        argv = runner.build_train_argv(runner.check_request(request(quantize4bit=True, buckets=False)), self.paths, resume_step=200)
        self.assertIn("--bnb_quantization_config_path=/j/bnb.json", argv)
        self.assertIn("--resume_from_checkpoint=checkpoint-200", argv)
        self.assertNotIn("--use_aspect_ratio_buckets", argv)


class Progress(unittest.TestCase):
    def test_reads_the_last_redraw(self):
        log = (
            "Caching latents: 100%|##########| 12/12\n"
            "Steps:   1%|          | 3/500 [00:10<30:00,  3.2s/it, loss=0.31, lr=0.0001]\r"
            "Steps:   1%|          | 4/500 [00:13<30:00,  3.2s/it, loss=0.29, lr=0.0001]\r"
        )
        self.assertEqual(runner.parse_progress(log), (4, 500, 0.29, 0.0001))

    def test_nothing_yet(self):
        self.assertEqual(runner.parse_progress("loading"), (None, None, None, None))

    def test_classifies_failures(self):
        self.assertEqual(runner.classify_failure("torch.OutOfMemoryError: CUDA out of memory.")["kind"], "oom")
        self.assertEqual(runner.classify_failure("OSError: [Errno 28] No space left on device")["kind"], "disk")
        self.assertEqual(runner.classify_failure("ModuleNotFoundError: No module named 'peft'")["kind"], "dependency")
        self.assertEqual(runner.classify_failure("huggingface_hub.errors.LocalEntryNotFoundError")["kind"], "model_missing")
        self.assertEqual(runner.classify_failure("Segmentation fault")["kind"], "unknown")

    def test_redacts(self):
        text = runner.redact("token=abc hf_" + "x" * 30 + " HF_TOKEN: zzz")
        self.assertNotIn("abc", text)
        self.assertNotIn("x" * 30, text)
        self.assertNotIn("zzz", text)


class Checkpoints(unittest.TestCase):
    def setUp(self):
        self.job = Path(tempfile.mkdtemp())
        out = self.job / "output"
        for step, state in [(100, True), (200, True), (300, False)]:
            d = out / f"checkpoint-{step}"
            d.mkdir(parents=True)
            (d / runner.LORA_FILE).write_bytes(b"x")
            if state:
                for name in runner.RESUME_FILES:
                    (d / name).write_bytes(b"s")
        (out / "checkpoint-400").mkdir()  # no LoRA yet: half written

    def tearDown(self):
        shutil.rmtree(self.job)

    def test_lists_written_checkpoints(self):
        found = runner.list_checkpoints(self.job, 500)
        self.assertEqual([c["step"] for c in found], [100, 200, 300])
        self.assertEqual([c["resumable"] for c in found], [True, True, False])

    def test_final_export_is_not_resumable(self):
        (self.job / "output" / runner.LORA_FILE).write_bytes(b"x")
        found = runner.list_checkpoints(self.job, 500)
        self.assertEqual(found[-1], {**found[-1], "step": 500, "kind": "final", "resumable": False})

    def test_resumes_from_latest_state(self):
        found = runner.list_checkpoints(self.job, 500)
        self.assertEqual(runner.resume_point(found, 500), 200)
        self.assertIsNone(runner.resume_point([c for c in found if not c["resumable"]], 500))
        self.assertIsNone(runner.resume_point(found, 100))

    def test_validation_steps(self):
        found = runner.list_checkpoints(self.job, 300)
        self.assertEqual(runner.validation_steps(found, 200, 300), [200, 300])


FAKE_TRAINER = r'''
import os, sys, time
args = dict(a[2:].split("=", 1) if "=" in a else (a[2:], "") for a in sys.argv[1:])
out = args["output_dir"]
total = int(args["max_train_steps"])
every = int(args["checkpointing_steps"])
start = int(args.get("resume_from_checkpoint", "checkpoint-0").split("-")[1])
delay = float(os.environ.get("FAKE_STEP_SECONDS", "0.05"))
for step in range(start + 1, total + 1):
    sys.stdout.write(f"\rSteps: {step*100//total:3d}%|#| {step}/{total} [00:01<00:01, 0.1s/it, loss={1/step:.4f}, lr=0.0001]")
    sys.stdout.flush()
    time.sleep(delay)
    if step % every == 0:
        d = os.path.join(out, f"checkpoint-{step}")
        os.makedirs(d, exist_ok=True)
        for name in ("pytorch_lora_weights.safetensors", "optimizer.bin", "scheduler.bin"):
            open(os.path.join(d, name), "wb").write(b"x")
        print(f"\nSaved state to {d}")
open(os.path.join(out, "pytorch_lora_weights.safetensors"), "wb").write(b"final")
'''


@unittest.skipUnless(os.name == "posix" and runner.fcntl, "needs process groups and flock")
class EndToEnd(unittest.TestCase):
    """The real supervisor with a fake trainer standing in for diffusers."""

    def setUp(self):
        self.ws = Path(tempfile.mkdtemp())
        (self.ws / "runner").mkdir()
        shutil.copy(runner.__file__, self.ws / "runner" / "runner.py")
        venv_bin = self.ws / "env" / "venv" / "bin"
        venv_bin.mkdir(parents=True)
        os.symlink(sys.executable, venv_bin / "python")
        script = self.ws / "env" / "trainers" / f"diffusers-v{runner.DIFFUSERS_VERSION}" / runner.TRAINER_SCRIPT
        script.parent.mkdir(parents=True)
        script.write_text(FAKE_TRAINER)
        model = self.ws / "model"
        model.mkdir()
        (self.ws / "env" / "models.json").write_text(json.dumps({"Qwen/Qwen-Image-2.1": {"path": str(model), "revision": "abc"}}))

    def tearDown(self):
        shutil.rmtree(self.ws, ignore_errors=True)

    def call(self, *args, stdin=""):
        proc = subprocess.run([sys.executable, str(self.ws / "runner" / "runner.py"), *args], input=stdin,
                              capture_output=True, text=True, timeout=60)
        return json.loads(proc.stdout)

    def upload(self, **train):
        req = request(**train)
        req["validation"]["prompts"] = []
        job = self.ws / "jobs" / req["jobId"]
        (job / "dataset").mkdir(parents=True)
        (job / "dataset" / "0001.png").write_bytes(b"png")
        req["dataset"]["files"][0]["sha256"] = runner.sha256_file(job / "dataset" / "0001.png")
        (job / "request.json").write_text(json.dumps(req))
        return req["jobId"]

    def wait(self, job_id, states, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            status = self.call("status", job_id)["result"]
            if status["state"] in states:
                return status
            time.sleep(0.3)
        self.fail(f"still {status['state']}")

    def test_trains_to_completion(self):
        job_id = self.upload(maxSteps=20, checkpointSteps=10)
        self.assertTrue(self.call("start", job_id)["ok"])
        status = self.wait(job_id, {"completed", "failed"})
        self.assertEqual(status["state"], "completed", status.get("logTail"))
        self.assertEqual([c["step"] for c in status["checkpoints"]], [10, 20])
        metadata = (self.ws / "jobs" / job_id / "dataset" / "metadata.jsonl").read_text()
        self.assertIn("whoami", json.loads(metadata.splitlines()[0])["text"])
        # A finished run cannot be started again.
        self.assertFalse(self.call("start", job_id)["ok"])

    def test_cancel_keeps_checkpoints_and_resumes(self):
        os.environ["FAKE_STEP_SECONDS"] = "0.2"
        try:
            job_id = self.upload(maxSteps=200, checkpointSteps=5)
            self.call("start", job_id)
            deadline = time.time() + 30
            while time.time() < deadline and not self.call("status", job_id)["result"]["checkpoints"]:
                time.sleep(0.3)
            self.call("cancel", job_id)
            status = self.wait(job_id, {"cancelled", "failed"}, timeout=90)
            self.assertEqual(status["state"], "cancelled")
            self.assertTrue(status["checkpoints"])
            self.assertEqual(status["resumeStep"], status["checkpoints"][-1]["step"])
        finally:
            os.environ.pop("FAKE_STEP_SECONDS", None)
        resumed = self.call("resume", job_id)
        self.assertTrue(resumed["ok"], resumed)
        status = self.wait(job_id, {"completed", "failed"}, timeout=90)
        self.assertEqual(status["state"], "completed")
        self.assertEqual(status["resumedFrom"], resumed["result"].get("resumedFrom") or status["resumedFrom"])

    def test_refuses_a_changed_dataset(self):
        job_id = self.upload()
        (self.ws / "jobs" / job_id / "dataset" / "0001.png").write_bytes(b"other")
        self.assertIn("differs", self.call("start", job_id)["error"])

    def test_cleanup_only_this_job(self):
        keep = self.upload()
        gone = self.upload()
        self.assertTrue(self.call("cleanup", gone)["ok"])
        self.assertFalse((self.ws / "jobs" / gone).exists())
        self.assertTrue((self.ws / "jobs" / keep).exists())
        self.assertFalse(self.call("cleanup", "../../etc")["ok"])


if __name__ == "__main__":
    unittest.main()
