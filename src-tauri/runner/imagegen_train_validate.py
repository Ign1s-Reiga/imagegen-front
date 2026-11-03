#!/usr/bin/env python3
"""ImageGen checkpoint validation, run by the training runner after a run.

Generates the run's validation prompts with fixed seeds, once with the base
model and once per selected checkpoint, so checkpoints can be compared image
for image. Runs in the training environment (it needs torch and diffusers):

    python validate-<version>.py <job dir> <model path>

Writes validation/<step>/<prompt>-<seed>.png and keeps validation/index.json
up to date after every image, so the app can show them as they arrive.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

LORA_FILE = "pytorch_lora_weights.safetensors"


def write_json(path: Path, data) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


def main(job: Path, model_path: str) -> int:
    import torch
    from diffusers import QwenImage21Pipeline

    request = json.loads((job / "request.json").read_text(encoding="utf-8"))
    status = json.loads((job / "status.json").read_text(encoding="utf-8"))
    v = request["validation"]
    t = request["train"]
    plan: list[int] = status.get("validationPlan") or []

    out = job / "validation"
    out.mkdir(exist_ok=True)
    index_path = out / "index.json"
    index = {"prompts": v["prompts"], "seeds": v["seeds"], "steps": v["steps"], "resolution": t["resolution"], "images": []}
    write_json(index_path, index)

    pipe = QwenImage21Pipeline.from_pretrained(model_path, torch_dtype=torch.bfloat16)
    # Keeps only the stage in use on the GPU, so validation fits wherever
    # training did.
    pipe.enable_model_cpu_offload()
    pipe.set_progress_bar_config(disable=True)

    def lora_dir(step: int) -> Path:
        checkpoint = job / "output" / f"checkpoint-{step}"
        return checkpoint if (checkpoint / LORA_FILE).is_file() else job / "output"

    targets: list[tuple[str, int | None]] = []
    if v.get("includeBase", True):
        targets.append(("base", None))
    targets += [(str(step), step) for step in plan]

    total = len(targets) * len(v["prompts"]) * len(v["seeds"])
    done = 0
    for label, step in targets:
        if step is not None:
            pipe.load_lora_weights(str(lora_dir(step)), weight_name=LORA_FILE)
        folder = out / label
        folder.mkdir(exist_ok=True)
        for p, prompt in enumerate(v["prompts"]):
            for seed in v["seeds"]:
                generator = torch.Generator(device="cpu").manual_seed(seed)
                image = pipe(
                    prompt,
                    num_inference_steps=v["steps"],
                    true_cfg_scale=1.0,
                    output_resolution=t["resolution"],
                    generator=generator,
                ).images[0]
                name = f"{p}-{seed}.png"
                # The pipeline returns RGBA (this VAE has four channels).
                image.convert("RGB").save(folder / name)
                done += 1
                index["images"].append({"step": step, "label": label, "prompt": p, "seed": seed, "file": f"{label}/{name}"})
                index["progress"] = {"done": done, "total": total, "at": time.time()}
                write_json(index_path, index)
        if step is not None:
            pipe.unload_lora_weights()
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]), sys.argv[2]))
