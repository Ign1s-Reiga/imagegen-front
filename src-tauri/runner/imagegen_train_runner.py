#!/usr/bin/env python3
"""ImageGen training runner.

Runs on the GPU host, next to the files it manages, and is driven by the
desktop app over SSH. Every call is `python3 runner-<version>.py <command>
[job id]`, with an optional JSON request on stdin, and answers with one JSON
object on stdout. Nothing the user typed (project names, captions, file
names) is ever put on a command line or into shell text: requests are data,
and every process this runner starts gets an argument list.

Layout under the workspace (the parent of this file's `runner` folder):

    runner/            this file and the validation script, by version
    env/venv/          the isolated training environment (never ComfyUI's)
    env/trainers/      upstream training scripts, pinned by hash
    env/models.json    base models downloaded by setup, with their revision
    env/setup-*.json   setup status and log
    hf-cache/          Hugging Face cache (HF_HOME) for those models
    jobs/<id>/         one training run: request, dataset, log, status, output
    lock/gpu.lock      held by the run that is using the GPU

A run keeps going when the SSH connection drops or the app closes: `start`
launches a detached supervisor and returns.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

try:
    import fcntl
except ImportError:  # not POSIX: only the pure functions are usable (tests)
    fcntl = None

RUNNER_VERSION = 1

# The one trainer this runner knows. Its script is fetched from the tagged
# diffusers release and checked against this hash before it is used.
TRAINER_ID = "diffusers-qwenimage21"
DIFFUSERS_VERSION = "0.42.1"
TRAINER_SCRIPT = "train_dreambooth_lora_qwenimage21.py"
TRAINER_URL = (
    f"https://raw.githubusercontent.com/huggingface/diffusers/v{DIFFUSERS_VERSION}"
    f"/examples/dreambooth/{TRAINER_SCRIPT}"
)
TRAINER_SHA256 = "10ceb1cdc1d0ed0bc0a4c9a38fc2a710b5f9659a32db5df47625457af8358f57"

# What the script's own header and the README ask for, with diffusers pinned
# to the release the script came from.
PACKAGES = [
    f"diffusers=={DIFFUSERS_VERSION}",
    "torch>=2.6",
    "torchvision",
    "accelerate>=0.31.0",
    "transformers>=4.57",
    "peft>=0.14.0",
    "datasets",
    "bitsandbytes",
    "safetensors",
    "huggingface_hub",
    "tensorboard",
    "ftfy",
    "Jinja2",
    "sentencepiece",
    "prodigyopt",
]

MODEL_COMPONENTS = ["transformer", "vae", "text_encoder", "scheduler"]

LORA_FILE = "pytorch_lora_weights.safetensors"
# What accelerate's save_state writes besides the LoRA: a checkpoint holding
# these can continue training; the LoRA file alone cannot.
RESUME_FILES = ["optimizer.bin", "scheduler.bin"]

JOB_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DATA_FILE = re.compile(r"^[0-9]{4,6}\.png$")
LORA_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.safetensors$")
REPO_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
REVISION = re.compile(r"^[A-Za-z0-9._/-]{1,100}$")
ABS_PATH = re.compile(r"^/[A-Za-z0-9._/-]*$")

TERMINAL = {"completed", "failed", "cancelled"}


class RequestError(Exception):
    """A request the runner refuses; reported to the app as is."""


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def workspace() -> Path:
    return Path(__file__).resolve().parent.parent


def env_dir(ws: Path) -> Path:
    return ws / "env"


def venv_python(ws: Path) -> Path:
    return env_dir(ws) / "venv" / "bin" / "python"


def trainer_script(ws: Path) -> Path:
    return env_dir(ws) / "trainers" / f"diffusers-v{DIFFUSERS_VERSION}" / TRAINER_SCRIPT


def validate_script(ws: Path) -> Path:
    return ws / "runner" / f"validate-{RUNNER_VERSION}.py"


def job_dir(ws: Path, job_id: str) -> Path:
    if not JOB_ID.match(job_id or ""):
        raise RequestError(f"not a job id: {job_id!r}")
    return ws / "jobs" / job_id


def checked_abs_path(value: object, what: str) -> Path:
    if not isinstance(value, str) or not ABS_PATH.match(value) or ".." in value.split("/"):
        raise RequestError(f"{what} must be an absolute path of letters, digits, '.', '_', '-' and '/'")
    return Path(value)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def now() -> float:
    return round(time.time(), 3)


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, data) -> None:
    """Writes atomically, so a reader never sees half a file."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


SECRET_PATTERNS = [
    (re.compile(r"hf_[A-Za-z0-9]{20,}"), "hf_***"),
    (re.compile(r"(?i)(token|password|secret|api[_-]?key)(\s*[=:]\s*)\S+"), r"\1\2***"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S), "[private key]"),
]


def redact(text: str) -> str:
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def tail(path: Path, limit: int = 64 * 1024) -> str:
    """The end of a log, with tqdm's carriage-return redraws collapsed."""
    try:
        with path.open("rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - limit))
            data = f.read().decode("utf-8", "replace")
    except OSError:
        return ""
    lines = [line.split("\r")[-1] for line in data.split("\n")]
    return redact("\n".join(lines))


def pid_alive(pid: object, marker: str | None = None) -> bool:
    """Whether the process runs, and, given a marker, is the one we started
    (its command line holds the marker), so a reused pid is never mistaken
    for ours."""
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    if marker is None:
        return True
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return False
    return marker in cmdline


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------


def _num(obj: dict, key: str, kind, lo, hi, default=None):
    value = obj.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RequestError(f"{key} must be a number")
    if kind is int and int(value) != value:
        raise RequestError(f"{key} must be a whole number")
    if not lo <= value <= hi:
        raise RequestError(f"{key} must be between {lo} and {hi}")
    return kind(value)


def _bool(obj: dict, key: str, default: bool = False) -> bool:
    value = obj.get(key, default)
    if not isinstance(value, bool):
        raise RequestError(f"{key} must be true or false")
    return value


def check_request(req: object) -> dict:
    """The training request with every field checked. The app checks the same
    things; this is the boundary that a request must pass on the host."""
    if not isinstance(req, dict) or req.get("version") != 1:
        raise RequestError("unsupported request version")
    if req.get("trainer") != TRAINER_ID:
        raise RequestError(f"unsupported trainer: {req.get('trainer')!r}")
    if not JOB_ID.match(str(req.get("jobId", ""))):
        raise RequestError("bad job id")
    model = req.get("model") or {}
    if not REPO_ID.match(str(model.get("repo", ""))):
        raise RequestError("bad model repository")
    if not REVISION.match(str(model.get("revision", "main"))):
        raise RequestError("bad model revision")

    dataset = req.get("dataset") or {}
    files = dataset.get("files")
    if not isinstance(files, list) or not files:
        raise RequestError("the dataset is empty")
    names = set()
    for item in files:
        if not isinstance(item, dict) or not DATA_FILE.match(str(item.get("name", ""))):
            raise RequestError("bad dataset file name")
        if item["name"] in names:
            raise RequestError("duplicate dataset file name")
        names.add(item["name"])
        if not re.fullmatch(r"[0-9a-f]{64}", str(item.get("sha256", ""))):
            raise RequestError("bad dataset file hash")
        if not isinstance(item.get("caption", ""), str) or len(item.get("caption", "")) > 4000:
            raise RequestError("bad caption")
    prompt = dataset.get("instancePrompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 500:
        raise RequestError("bad instance prompt")

    t = req.get("train") or {}
    train = {
        "resolution": _num(t, "resolution", int, 256, 2048),
        "buckets": _bool(t, "buckets", True),
        "rank": _num(t, "rank", int, 1, 256),
        "alpha": _num(t, "alpha", int, 1, 512),
        "learningRate": _num(t, "learningRate", float, 1e-7, 1e-2),
        "batchSize": _num(t, "batchSize", int, 1, 16),
        "gradAccum": _num(t, "gradAccum", int, 1, 64),
        "maxSteps": _num(t, "maxSteps", int, 1, 100000),
        "seed": _num(t, "seed", int, 0, 2**31 - 1),
        "precision": t.get("precision", "bf16"),
        "use8bitAdam": _bool(t, "use8bitAdam", True),
        "gradientCheckpointing": _bool(t, "gradientCheckpointing", True),
        "cacheLatents": _bool(t, "cacheLatents", True),
        "offload": _bool(t, "offload", False),
        "quantize4bit": _bool(t, "quantize4bit", False),
        "lrScheduler": t.get("lrScheduler", "constant"),
        "warmupSteps": _num(t, "warmupSteps", int, 0, 100000, 0),
        "checkpointSteps": _num(t, "checkpointSteps", int, 1, 100000),
        "randomFlip": _bool(t, "randomFlip", False),
        "captionDropout": _num(t, "captionDropout", float, 0.0, 1.0, 0.0),
        "loraLayers": t.get("loraLayers"),
    }
    if train["resolution"] % 32:
        raise RequestError("resolution must be a multiple of 32")
    if train["precision"] not in ("bf16", "fp16", "no"):
        raise RequestError("precision must be bf16, fp16 or no")
    if train["lrScheduler"] not in ("constant", "constant_with_warmup", "linear", "cosine"):
        raise RequestError("unsupported learning rate schedule")
    layers = train["loraLayers"]
    if layers is not None and (not isinstance(layers, str) or not re.fullmatch(r"[A-Za-z0-9_.]+(,[A-Za-z0-9_.]+)*", layers)):
        raise RequestError("LoRA layers must be a comma-separated list of module names")

    v = req.get("validation") or {}
    prompts = v.get("prompts", [])
    seeds = v.get("seeds", [])
    if not isinstance(prompts, list) or len(prompts) > 8 or not all(isinstance(p, str) and 0 < len(p) <= 1000 for p in prompts):
        raise RequestError("validation prompts must be up to 8 non-empty texts")
    if not isinstance(seeds, list) or len(seeds) > 4 or not all(isinstance(s, int) and not isinstance(s, bool) and 0 <= s < 2**31 for s in seeds):
        raise RequestError("validation seeds must be up to 4 whole numbers")
    validation = {
        "prompts": prompts,
        "seeds": seeds or [0],
        "everySteps": _num(v, "everySteps", int, 1, 100000, train["checkpointSteps"]),
        "steps": _num(v, "steps", int, 1, 100, 40),
        "includeBase": _bool(v, "includeBase", True),
    }
    if validation["everySteps"] % train["checkpointSteps"]:
        raise RequestError("the validation interval must be a multiple of the checkpoint interval")

    return {
        "version": 1,
        "jobId": req["jobId"],
        "trainer": TRAINER_ID,
        "model": {"repo": model["repo"], "revision": model.get("revision", "main")},
        "dataset": {"files": files, "instancePrompt": prompt},
        "train": train,
        "validation": validation,
    }


def build_train_argv(req: dict, paths: dict, resume_step: int | None = None) -> list[str]:
    """The trainer's command line, as a list. Every value is a separate
    argument; none of it passes through a shell."""
    t = req["train"]
    argv = [
        str(paths["python"]),
        str(paths["script"]),
        f"--pretrained_model_name_or_path={paths['model']}",
        f"--dataset_name={paths['dataset']}",
        "--image_column=image",
        "--caption_column=text",
        f"--instance_prompt={req['dataset']['instancePrompt']}",
        f"--output_dir={paths['output']}",
        f"--logging_dir={paths['logs']}",
        "--report_to=tensorboard",
        f"--mixed_precision={t['precision']}",
        f"--resolution={t['resolution']}",
        f"--train_batch_size={t['batchSize']}",
        f"--gradient_accumulation_steps={t['gradAccum']}",
        f"--rank={t['rank']}",
        f"--lora_alpha={t['alpha']}",
        f"--learning_rate={t['learningRate']}",
        f"--lr_scheduler={t['lrScheduler']}",
        f"--lr_warmup_steps={t['warmupSteps']}",
        f"--max_train_steps={t['maxSteps']}",
        f"--checkpointing_steps={t['checkpointSteps']}",
        f"--seed={t['seed']}",
        # Validation runs afterwards, per checkpoint, with fixed prompts and
        # seeds (see validate.py); the trainer's own pass would only log to
        # TensorBoard, so it is skipped.
        "--skip_final_inference",
    ]
    if t["buckets"]:
        argv.append("--use_aspect_ratio_buckets")
    if t["use8bitAdam"]:
        argv.append("--use_8bit_adam")
    if t["gradientCheckpointing"]:
        argv.append("--gradient_checkpointing")
    if t["cacheLatents"]:
        argv.append("--cache_latents")
    if t["offload"]:
        argv.append("--offload")
    if t["randomFlip"]:
        argv.append("--random_flip")
    if t["captionDropout"] > 0:
        argv.append(f"--caption_dropout={t['captionDropout']}")
    if t["loraLayers"]:
        argv.append(f"--lora_layers={t['loraLayers']}")
    if t["quantize4bit"]:
        argv.append(f"--bnb_quantization_config_path={paths['bnb']}")
    if resume_step is not None:
        argv.append(f"--resume_from_checkpoint=checkpoint-{resume_step}")
    return argv


# ---------------------------------------------------------------------------
# Trainer output
# ---------------------------------------------------------------------------

PROGRESS = re.compile(r"Steps:\s*\d+%\|[^|\r\n]*\|\s*(\d+)/(\d+)[^\r\n]*")
LOSS = re.compile(r"loss=([0-9.eE+-]+)")
LR = re.compile(r"lr=([0-9.eE+-]+)")


def parse_progress(text: str):
    """The last step, step total and loss the trainer's progress bar showed;
    None for each it has not shown."""
    step = total = loss = lr = None
    for match in PROGRESS.finditer(text):
        step, total = int(match.group(1)), int(match.group(2))
        found = LOSS.search(match.group(0))
        if found:
            try:
                loss = float(found.group(1))
            except ValueError:
                pass
        found = LR.search(match.group(0))
        if found:
            try:
                lr = float(found.group(1))
            except ValueError:
                pass
    return step, total, loss, lr


def classify_failure(log: str) -> dict:
    """What a failed run's log says went wrong, in words the app can act on."""
    checks = [
        ("oom", r"CUDA out of memory|OutOfMemoryError|CUBLAS_STATUS_ALLOC_FAILED",
         "The GPU ran out of memory. Turn on 4-bit quantization, offloading or gradient checkpointing, or lower the resolution or batch size."),
        ("disk", r"No space left on device|Disk quota exceeded",
         "The host ran out of disk space. Free space under the workspace, or remove old training jobs."),
        ("dependency", r"ModuleNotFoundError|ImportError|requires a minimum version|check_min_version",
         "A training dependency is missing or too old. Run environment setup again."),
        ("model_missing", r"LocalEntryNotFoundError|does not appear to have a file named|Repository Not Found|is not a local folder|OfflineModeIsEnabled",
         "A base model file is missing on the host. Run environment setup with the model download."),
        ("data", r"Instance images root doesn't exists|must be a multiple of|cannot identify image file",
         "The trainer could not read the dataset."),
    ]
    for kind, pattern, message in checks:
        if re.search(pattern, log):
            return {"kind": kind, "message": message}
    return {"kind": "unknown", "message": "Training stopped with an error. See the log."}


def list_checkpoints(job: Path, max_steps: int | None) -> list[dict]:
    """Checkpoints the trainer wrote, oldest first. The LoRA it exports at the
    end is listed as the last step, without training state."""
    out = job / "output"
    found = []
    if out.is_dir():
        for entry in out.iterdir():
            match = re.fullmatch(r"checkpoint-(\d+)", entry.name)
            lora = entry / LORA_FILE
            if match and lora.is_file():
                found.append({
                    "step": int(match.group(1)),
                    "kind": "checkpoint",
                    "loraPath": str(lora),
                    "size": lora.stat().st_size,
                    "resumable": all((entry / name).is_file() for name in RESUME_FILES),
                })
        final = out / LORA_FILE
        if final.is_file() and max_steps:
            if not any(c["step"] == max_steps for c in found):
                found.append({
                    "step": max_steps,
                    "kind": "final",
                    "loraPath": str(final),
                    "size": final.stat().st_size,
                    "resumable": False,
                })
    return sorted(found, key=lambda c: c["step"])


def resume_point(checkpoints: list[dict], max_steps: int) -> int | None:
    """The step a stopped run can continue from: its latest checkpoint that
    holds training state, if that is short of the end. An exported LoRA alone
    cannot be resumed."""
    steps = [c["step"] for c in checkpoints if c["resumable"] and c["step"] < max_steps]
    return max(steps) if steps else None


def validation_steps(checkpoints: list[dict], every: int, max_steps: int) -> list[int]:
    steps = {c["step"] for c in checkpoints if c["step"] % every == 0 or c["step"] == max_steps}
    return sorted(steps)


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------


def job_status(ws: Path, job_id: str) -> dict:
    job = job_dir(ws, job_id)
    if not job.is_dir():
        return {"jobId": job_id, "state": "missing"}
    status = read_json(job / "status.json", {}) or {}
    req = read_json(job / "request.json", {}) or {}
    max_steps = (req.get("train") or {}).get("maxSteps")
    state = status.get("state", "uploaded")
    # A supervisor that died without a final word (the host restarted, it
    # was killed) leaves a state that is no longer true.
    if state not in TERMINAL and state != "uploaded" and not pid_alive(status.get("supervisorPid"), job_id):
        state = "failed"
        status["error"] = {
            "kind": "interrupted",
            "message": "The training process is no longer running on the host (it was stopped, or the host restarted).",
        }
    checkpoints = list_checkpoints(job, max_steps)
    status.update({
        "jobId": job_id,
        "state": state,
        "maxSteps": max_steps,
        "checkpoints": checkpoints,
        "resumeStep": resume_point(checkpoints, max_steps) if state in ("failed", "cancelled") and max_steps else None,
        "validation": read_json(job / "validation" / "index.json", {"images": []}),
        "logTail": tail(job / "train.log", 24 * 1024),
        "now": now(),
    })
    return status


def update_status(job: Path, **fields) -> dict:
    status = read_json(job / "status.json", {}) or {}
    status.update(fields)
    status["updatedAt"] = now()
    write_json(job / "status.json", status)
    return status


# ---------------------------------------------------------------------------
# Supervisor: runs detached, owns one job from queue to final state
# ---------------------------------------------------------------------------


def spawn_detached(args: list[str], log: Path) -> int:
    with log.open("ab") as out, open(os.devnull, "rb") as devnull:
        proc = subprocess.Popen(
            args,
            stdin=devnull,
            stdout=out,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
    return proc.pid


def kill_group(pid: int, grace: float = 60.0) -> None:
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.time() + grace
    while time.time() < deadline:
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(1)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def model_snapshot(ws: Path, repo: str) -> dict | None:
    models = read_json(env_dir(ws) / "models.json", {}) or {}
    return models.get(repo)


def run_child(job: Path, argv: list[str], env: dict, log: Path, on_tick) -> tuple[int, bool]:
    """Runs one child in its own process group, calling on_tick every couple
    of seconds; a cancel request stops the whole group. Returns the exit code
    and whether it was cancelled."""
    with log.open("ab") as out, open(os.devnull, "rb") as devnull:
        proc = subprocess.Popen(argv, stdin=devnull, stdout=out, stderr=subprocess.STDOUT, env=env, start_new_session=True)
    update_status(job, childPid=proc.pid)
    cancelled = False
    while proc.poll() is None:
        if (job / "cancel").exists() and not cancelled:
            cancelled = True
            kill_group(proc.pid)
        on_tick()
        time.sleep(2)
    return proc.returncode, cancelled


def supervise(ws: Path, job_id: str, resume_step: int | None) -> None:
    job = job_dir(ws, job_id)
    req = check_request(read_json(job / "request.json"))
    t = req["train"]
    log = job / "train.log"
    update_status(
        job,
        state="queued",
        supervisorPid=os.getpid(),
        queuedAt=now(),
        error=None,
        resumedFrom=resume_step,
        trainer=TRAINER_ID,
        trainerVersion=f"diffusers-{DIFFUSERS_VERSION}",
        runnerVersion=RUNNER_VERSION,
    )

    # One run on the GPU at a time; a second waits here, as "queued".
    (ws / "lock").mkdir(exist_ok=True)
    lock = (ws / "lock" / "gpu.lock").open("w")
    while True:
        if (job / "cancel").exists():
            update_status(job, state="cancelled", finishedAt=now())
            return
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            time.sleep(5)
    lock.write(job_id)
    lock.flush()

    snapshot = model_snapshot(ws, req["model"]["repo"])
    if not snapshot or not Path(snapshot["path"]).is_dir():
        update_status(job, state="failed", finishedAt=now(), error={
            "kind": "model_missing",
            "message": f"{req['model']['repo']} is not downloaded on this host. Run environment setup with the model download.",
        })
        return

    paths = {
        "python": venv_python(ws),
        "script": trainer_script(ws),
        "model": snapshot["path"],
        "dataset": job / "dataset",
        "output": job / "output",
        "logs": job / "tb",
        "bnb": job / "bnb.json",
    }
    if t["quantize4bit"]:
        # The README's example quantization config.
        write_json(job / "bnb.json", {"load_in_4bit": True, "bnb_4bit_quant_type": "nf4"})
    env = dict(os.environ)
    for key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        env.pop(key, None)
    env.update({
        "HF_HOME": str(ws / "hf-cache"),
        "HF_HUB_OFFLINE": "1",
        "PYTHONUNBUFFERED": "1",
        "TOKENIZERS_PARALLELISM": "false",
    })

    update_status(job, state="preparing", startedAt=now(), modelRevision=snapshot.get("revision"))
    seen = {"offset": 0, "first": None, "history": []}

    def on_tick():
        try:
            with log.open("rb") as f:
                f.seek(max(0, seen["offset"] - 4096))
                text = f.read().decode("utf-8", "replace")
                seen["offset"] = f.tell()
        except OSError:
            return
        step, _total, loss, lr = parse_progress(text)
        if step is None:
            return
        if seen["first"] is None:
            seen["first"] = (step, time.time())
        if loss is not None and (not seen["history"] or seen["history"][-1][0] != step):
            seen["history"].append([step, loss])
            del seen["history"][:-2000]
        state = "saving" if "Saved state to" in text.split("Steps:")[-1] else "training"
        first_step, first_time = seen["first"]
        rate = (time.time() - first_time) / (step - first_step) if step > first_step else None
        update_status(job, state=state, step=step, loss=loss, lr=lr, secondsPerStep=rate, lossHistory=seen["history"])

    code, cancelled = run_child(job, build_train_argv(req, paths, resume_step), env, log, on_tick)
    on_tick()
    if cancelled:
        update_status(job, state="cancelled", finishedAt=now(), childPid=None)
        return
    if code != 0:
        update_status(job, state="failed", finishedAt=now(), exitCode=code, childPid=None,
                      error=classify_failure(tail(log, 256 * 1024)))
        return

    checkpoints = list_checkpoints(job, t["maxSteps"])
    v = req["validation"]
    if v["prompts"]:
        steps = validation_steps(checkpoints, v["everySteps"], t["maxSteps"])
        update_status(job, state="validating", validationPlan=steps, childPid=None)
        vargs = [str(paths["python"]), str(validate_script(ws)), str(job), str(paths["model"])]
        code, cancelled = run_child(job, vargs, env, job / "validation.log", lambda: None)
        if cancelled:
            update_status(job, state="cancelled", finishedAt=now(), childPid=None)
            return
        if code != 0:
            # The LoRA is trained; only the comparison images are missing.
            update_status(job, validationError=classify_failure(tail(job / "validation.log", 256 * 1024))["message"])
    update_status(job, state="completed", finishedAt=now(), childPid=None)


# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------


def setup_status_path(ws: Path) -> Path:
    return env_dir(ws) / "setup-status.json"


def run_setup(ws: Path, request: dict) -> None:
    env_root = env_dir(ws)
    status_path = setup_status_path(ws)
    log = env_root / "setup.log"
    token = request.get("hfToken") or None
    write_json(status_path, {"state": "running", "step": "starting", "startedAt": now(), "pid": os.getpid()})

    def step(name: str, argv: list[str], env=None):
        write_json(status_path, {**read_json(status_path, {}), "step": name})
        with log.open("ab") as out:
            out.write(f"\n== {name}\n".encode())
            out.flush()
            code = subprocess.call(argv, stdout=out, stderr=subprocess.STDOUT, env=env)
        if code != 0:
            raise RuntimeError(f"{name} failed (exit {code}); see the setup log")

    try:
        venv = env_root / "venv"
        if not venv_python(ws).exists():
            step("Creating the training environment", [sys.executable, "-m", "venv", str(venv)])
        py = str(venv_python(ws))
        step("Updating pip", [py, "-m", "pip", "install", "--upgrade", "pip"])
        step("Installing training packages", [py, "-m", "pip", "install", *PACKAGES])

        script = trainer_script(ws)
        if not script.is_file() or sha256_file(script) != TRAINER_SHA256:
            write_json(status_path, {**read_json(status_path, {}), "step": "Downloading the training script"})
            script.parent.mkdir(parents=True, exist_ok=True)
            with urllib.request.urlopen(TRAINER_URL, timeout=120) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != TRAINER_SHA256:
                raise RuntimeError("The downloaded training script does not match the pinned version.")
            script.write_bytes(data)

        model = request.get("model")
        if model:
            env = dict(os.environ)
            env["HF_HOME"] = str(ws / "hf-cache")
            env.pop("HF_HUB_OFFLINE", None)
            if token:
                env["HF_TOKEN"] = token
            out_file = env_root / "download.json"
            code = (
                "import json,sys\n"
                "from huggingface_hub import snapshot_download, HfApi\n"
                "repo, revision, out = sys.argv[1], sys.argv[2], sys.argv[3]\n"
                "info = HfApi().model_info(repo, revision=revision)\n"
                "path = snapshot_download(repo, revision=info.sha)\n"
                "json.dump({'path': path, 'revision': info.sha}, open(out, 'w'))\n"
            )
            step(f"Downloading {model['repo']}", [py, "-c", code, model["repo"], model.get("revision", "main"), str(out_file)], env)
            got = read_json(out_file)
            models = read_json(env_root / "models.json", {}) or {}
            models[model["repo"]] = {"path": got["path"], "revision": got["revision"], "downloadedAt": now()}
            write_json(env_root / "models.json", models)

        write_json(status_path, {**read_json(status_path, {}), "state": "completed", "step": None, "finishedAt": now()})
    except Exception as err:  # noqa: BLE001 - every failure is reported as status
        write_json(status_path, {**read_json(status_path, {}), "state": "failed", "error": redact(str(err)), "finishedAt": now()})


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------


def run_quiet(argv: list[str], timeout: float = 60) -> tuple[int, str]:
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout + proc.stderr
    except (OSError, subprocess.TimeoutExpired) as err:
        return -1, str(err)


def gpu_info() -> dict:
    code, out = run_quiet(["nvidia-smi", "--query-gpu=index,name,memory.total,memory.used,driver_version", "--format=csv,noheader,nounits"])
    if code != 0:
        return {"error": "nvidia-smi is not available or found no GPU.", "gpus": [], "processes": []}
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 5:
            gpus.append({"index": int(parts[0]), "name": parts[1], "memoryTotalMiB": int(float(parts[2])),
                         "memoryUsedMiB": int(float(parts[3])), "driver": parts[4]})
    processes = []
    code, out = run_quiet(["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"])
    if code == 0:
        for line in out.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                try:
                    processes.append({"pid": int(parts[0]), "name": parts[1], "memoryMiB": int(float(parts[2]))})
                except ValueError:
                    pass
    return {"gpus": gpus, "processes": processes}


ENV_PROBE = r"""
import json, importlib.metadata as m
out = {"packages": {}}
for name in ["diffusers", "torch", "transformers", "accelerate", "peft", "datasets", "bitsandbytes"]:
    try:
        out["packages"][name] = m.version(name)
    except m.PackageNotFoundError:
        out["packages"][name] = None
try:
    import torch
    out["cuda"] = torch.cuda.is_available()
    out["torchCuda"] = torch.version.cuda
except Exception as err:
    out["cuda"] = False
    out["torchError"] = str(err)[:300]
try:
    from diffusers import QwenImage21Pipeline  # noqa: F401
    out["pipeline"] = True
except Exception as err:
    out["pipeline"] = False
    out["pipelineError"] = str(err)[:300]
print(json.dumps(out))
"""


def preflight(ws: Path, request: dict) -> dict:
    info: dict = {"runnerVersion": RUNNER_VERSION, "python": sys.version.split()[0], "workspace": str(ws)}
    info.update(gpu_info())
    usage = shutil.disk_usage(ws)
    info["disk"] = {"freeBytes": usage.free, "totalBytes": usage.total}

    env = {"venv": venv_python(ws).exists(), "trainerScript": trainer_script(ws).is_file()}
    if env["trainerScript"]:
        env["trainerScriptVerified"] = sha256_file(trainer_script(ws)) == TRAINER_SHA256
    if env["venv"]:
        code, out = run_quiet([str(venv_python(ws)), "-c", ENV_PROBE], timeout=180)
        try:
            env.update(json.loads(out.strip().splitlines()[-1]))
        except (ValueError, IndexError):
            env["probeError"] = redact(out[-500:])
    info["environment"] = env
    info["setup"] = read_json(setup_status_path(ws), None)

    repo = (request.get("model") or {}).get("repo")
    if repo:
        snap = model_snapshot(ws, repo)
        model = {"repo": repo, "downloaded": False}
        if snap and Path(snap["path"]).is_dir():
            path = Path(snap["path"])
            missing = [c for c in MODEL_COMPONENTS if not (path / c).is_dir()]
            if not (path / "model_index.json").is_file():
                missing.insert(0, "model_index.json")
            model.update({"downloaded": not missing, "missing": missing, "revision": snap.get("revision"), "path": str(path)})
        info["model"] = model

    lora_dir = request.get("loraDir")
    if lora_dir:
        target = checked_abs_path(lora_dir, "the LoRA folder")
        info["loraDir"] = {"path": str(target), "exists": target.is_dir(), "writable": os.access(target, os.W_OK)}

    jobs = []
    root = ws / "jobs"
    if root.is_dir():
        for entry in sorted(root.iterdir()):
            if JOB_ID.match(entry.name):
                status = read_json(entry / "status.json", {}) or {}
                alive = pid_alive(status.get("supervisorPid"), entry.name)
                jobs.append({"jobId": entry.name, "state": status.get("state", "uploaded"), "running": alive})
    info["jobs"] = jobs
    return info


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def read_stdin() -> dict:
    data = sys.stdin.read() if not sys.stdin.isatty() else ""
    if not data.strip():
        return {}
    value = json.loads(data)
    if not isinstance(value, dict):
        raise RequestError("the request must be a JSON object")
    return value


def cmd_start(ws: Path, job_id: str, resume: bool) -> dict:
    job = job_dir(ws, job_id)
    req = check_request(read_json(job / "request.json"))
    status = job_status(ws, job_id)
    if status["state"] not in ("uploaded", "failed", "cancelled"):
        if status["state"] in TERMINAL:
            raise RequestError(f"this run has {status['state']}")
        raise RequestError("this run is already running")
    for item in req["dataset"]["files"]:
        path = job / "dataset" / item["name"]
        if not path.is_file() or sha256_file(path) != item["sha256"]:
            raise RequestError(f"dataset file {item['name']} is missing or differs from the upload")
    resume_step = None
    if resume:
        resume_step = status.get("resumeStep")
        if resume_step is None:
            raise RequestError("this run has no checkpoint with training state to resume from")
    elif status["state"] != "uploaded":
        raise RequestError("this run already started; resume it or start a new run")
    # The trainer reads captions from metadata.jsonl, written here from the
    # request so that no caption is ever part of a command.
    with (job / "dataset" / "metadata.jsonl").open("w", encoding="utf-8") as f:
        for item in req["dataset"]["files"]:
            f.write(json.dumps({"file_name": item["name"], "text": item.get("caption", "")}) + "\n")
    (job / "cancel").unlink(missing_ok=True)
    args = [sys.executable, str(Path(__file__).resolve()), "_supervise", job_id]
    if resume_step is not None:
        args.append(str(resume_step))
    # Recorded at once, so a status read before the supervisor writes its own
    # sees a live run rather than an interrupted one.
    pid = spawn_detached(args, job / "supervisor.log")
    update_status(job, state="queued", supervisorPid=pid, error=None)
    return job_status(ws, job_id)


def cmd_cancel(ws: Path, job_id: str) -> dict:
    job = job_dir(ws, job_id)
    if not job.is_dir():
        raise RequestError("no such job on this host")
    (job / "cancel").touch()
    status = read_json(job / "status.json", {}) or {}
    if not pid_alive(status.get("supervisorPid"), job_id):
        # No supervisor to act on the request: stop the trainer it left, if
        # that is still ours, and record the end.
        child = status.get("childPid")
        if pid_alive(child, str(job)):
            kill_group(child, grace=30)
        if status.get("state") not in TERMINAL:
            update_status(job, state="cancelled", finishedAt=now(), childPid=None)
    return job_status(ws, job_id)


def cmd_cleanup(ws: Path, job_id: str) -> dict:
    job = job_dir(ws, job_id)
    status = read_json(job / "status.json", {}) or {}
    if pid_alive(status.get("supervisorPid"), job_id):
        raise RequestError("this run is still running; cancel it first")
    if job.is_dir():
        shutil.rmtree(job)
    return {"jobId": job_id, "removed": True}


def cmd_dataset_hashes(ws: Path, job_id: str) -> dict:
    data = job_dir(ws, job_id) / "dataset"
    hashes = {}
    if data.is_dir():
        for entry in data.iterdir():
            if DATA_FILE.match(entry.name) and entry.is_file():
                hashes[entry.name] = sha256_file(entry)
    return {"hashes": hashes}


def cmd_file_hash(request: dict) -> dict:
    """Hash of a LoRA the app installed, to confirm the copy is whole."""
    folder = checked_abs_path(request.get("dir"), "the LoRA folder")
    name = request.get("name")
    if not isinstance(name, str) or not LORA_NAME.match(name):
        raise RequestError("bad LoRA file name")
    path = folder / name
    if not path.is_file():
        return {"exists": False}
    return {"exists": True, "sha256": sha256_file(path), "size": path.stat().st_size}


def cmd_lora_hash(ws: Path, job_id: str, request: dict) -> dict:
    step = request.get("step")
    if not isinstance(step, int) or isinstance(step, bool):
        raise RequestError("bad step")
    req = read_json(job_dir(ws, job_id) / "request.json", {}) or {}
    for checkpoint in list_checkpoints(job_dir(ws, job_id), (req.get("train") or {}).get("maxSteps")):
        if checkpoint["step"] == step:
            path = Path(checkpoint["loraPath"])
            return {"path": str(path), "sha256": sha256_file(path), "size": path.stat().st_size}
    raise RequestError(f"no LoRA at step {step}")


def main(argv: list[str]) -> int:
    ws = workspace()
    try:
        if len(argv) < 2:
            raise RequestError("no command")
        command, rest = argv[1], argv[2:]
        if command == "_supervise":
            supervise(ws, rest[0], int(rest[1]) if len(rest) > 1 else None)
            return 0
        if command == "_setup":
            run_setup(ws, read_json(env_dir(ws) / "setup-request.json", {}) or {})
            (env_dir(ws) / "setup-request.json").unlink(missing_ok=True)
            return 0
        request = read_stdin()
        if command == "version":
            result = {"runnerVersion": RUNNER_VERSION, "trainer": TRAINER_ID, "diffusers": DIFFUSERS_VERSION}
        elif command == "preflight":
            result = preflight(ws, request)
        elif command == "setup":
            status = read_json(setup_status_path(ws), {}) or {}
            if status.get("state") == "running" and pid_alive(status.get("pid"), "_setup"):
                raise RequestError("environment setup is already running")
            env_dir(ws).mkdir(parents=True, exist_ok=True)
            model = request.get("model")
            if model is not None and (not REPO_ID.match(str(model.get("repo", ""))) or not REVISION.match(str(model.get("revision", "main")))):
                raise RequestError("bad model")
            # The token goes to the setup process in a private file it
            # deletes on start, never on a command line.
            request_path = env_dir(ws) / "setup-request.json"
            fd = os.open(request_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump({"model": model, "hfToken": request.get("hfToken")}, f)
            pid = spawn_detached([sys.executable, str(Path(__file__).resolve()), "_setup"], env_dir(ws) / "setup.log")
            write_json(setup_status_path(ws), {"state": "running", "step": "starting", "startedAt": now(), "pid": pid})
            result = {"setup": read_json(setup_status_path(ws))}
        elif command == "setup-status":
            status = read_json(setup_status_path(ws), None)
            if status and status.get("state") == "running" and not pid_alive(status.get("pid"), "_setup"):
                status = {**status, "state": "failed", "error": "Setup stopped before it finished."}
            result = {"setup": status, "logTail": tail(env_dir(ws) / "setup.log", 16 * 1024)}
        elif command == "status":
            result = job_status(ws, rest[0])
        elif command == "start":
            result = cmd_start(ws, rest[0], resume=False)
        elif command == "resume":
            result = cmd_start(ws, rest[0], resume=True)
        elif command == "cancel":
            result = cmd_cancel(ws, rest[0])
        elif command == "cleanup":
            result = cmd_cleanup(ws, rest[0])
        elif command == "dataset-hashes":
            result = cmd_dataset_hashes(ws, rest[0])
        elif command == "lora-hash":
            result = cmd_lora_hash(ws, rest[0], request)
        elif command == "file-hash":
            result = cmd_file_hash(request)
        else:
            raise RequestError(f"unknown command: {command}")
        print(json.dumps({"ok": True, "result": result}))
    except RequestError as err:
        print(json.dumps({"ok": False, "error": str(err)}))
    except Exception as err:  # noqa: BLE001 - the app shows the message
        print(json.dumps({"ok": False, "error": redact(f"{type(err).__name__}: {err}")}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
