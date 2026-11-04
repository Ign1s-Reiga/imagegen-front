# LoRA training

The Training page trains a personal identity LoRA from your own photographs, on a GPU machine you already run, and makes the result usable in Generate through a ComfyUI workflow.

## What is implemented

| | |
| --- | --- |
| Model family | Qwen-Image 2.1 |
| Base model | [`Qwen/Qwen-Image-2.1`](https://huggingface.co/Qwen/Qwen-Image-2.1) (Diffusers format), at the revision the host downloaded, which each run records |
| Trainer | Diffusers v0.42.1 [`train_dreambooth_lora_qwenimage21.py`](https://github.com/huggingface/diffusers/blob/v0.42.1/examples/dreambooth/train_dreambooth_lora_qwenimage21.py), pinned by SHA-256 (`10ceb1cd…8f57`) |
| Output | A PEFT LoRA in Diffusers naming (`transformer.transformer_blocks.*.lora_A/B.weight`), `pytorch_lora_weights.safetensors` |
| Where it runs | Any Linux host with an NVIDIA GPU and SSH, such as an existing RunPod Pod |
| Where it is used | ComfyUI, through a `LoraLoaderModelOnly` (or `LoraLoader`) node in a Qwen-Image 2.1 workflow. ComfyUI maps `transformer.*` LoRA keys for Qwen-Image 2.1 (see `comfy/lora.py`) |

Nothing else is trained here: not Qwen-Image 2.1 Turbo (the script documents only the base model), not Qwen-Image 1.x (a different transformer), and not MOSS, FLUX or SDXL. The app says so when a project or a LoRA would need one of them, and it refuses to load a LoRA into a workflow whose model it cannot identify as Qwen-Image 2.1.

The model is under the Qwen Research License; check that it covers your use.

## The preset

It starts from the upstream example in `README_qwenimage21.md`: learning rate 1e-4, batch 1 with 4 gradient accumulation steps, 500 steps, a constant schedule without warmup, 8-bit Adam, bf16 and resolution 1024. Three choices for photographs of a person are made from the script's own documented options:

- **Rank and alpha 16/16.** These are the script's defaults. The README's rank section advises keeping alpha equal to rank (scale 1) over the 4/4 of its dog example.
- **Aspect-ratio buckets (`--use_aspect_ratio_buckets`)**, so full-body photos are not cropped to a square.
- **`--cache_latents` and `--gradient_checkpointing`**, the documented memory savers.

A checkpoint is saved every 100 steps. After training, each checkpoint is validated with fixed prompts and seeds, plus the base model without the LoRA for comparison, at 40 sampling steps without guidance, as the model's docs do. Everything else is under *Advanced*: rank, alpha, learning rate, schedule, batch, accumulation, precision, 8-bit Adam, offloading, 4-bit NF4 quantization (the README's bitsandbytes example), buckets, flip, caption dropout, seeds and intervals.

The upstream docs give no VRAM requirement, so the app does not invent one. If a run fails out of memory, the error says so and points at the memory options.

## Setting up a RunPod Pod

The app never creates, stops or deletes Pods. Use one you already have.

1. On the Pod, enable **SSH over exposed TCP** (a public IP and a mapped port). The `ssh.runpod.io` proxy does not support file transfer, so it does not work here.
2. Put your public key in `~/.ssh/authorized_keys` on the Pod (RunPod adds the key from your account settings).
3. In **Connections > GPU host (SSH)**, enter the IP, the mapped port, the user (`root`), and paste the private key. Keys and passphrases go to the OS keychain and are read only by the Rust side.
4. Keep the workspace under `/workspace` (default `/workspace/imagegen-train`) so it survives a Pod restart.
5. If ComfyUI runs on the same Pod, set *ComfyUI LoRA folder*, typically `/workspace/ComfyUI/models/loras`.
6. Click *Test connection*. The first time, the app shows the host key's fingerprint. Compare it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the Pod, then trust it. A key that later changes is refused.
7. On the Training page, open a project, then **Train > Check host**, then **Set up environment** with *Download Qwen/Qwen-Image-2.1* ticked. This creates `<workspace>/env/venv` with `diffusers==0.42.1`, PyTorch, transformers, PEFT, accelerate, datasets and bitsandbytes, fetches the pinned script and checks its hash, and downloads the model into `<workspace>/hf-cache`. It runs in the background on the Pod. ComfyUI's Python environment is never touched.

## Where things are

On this computer, in the app data folder (`%APPDATA%\io.imagegen.desktop\training` on Windows):

- `training.sqlite3`: projects, photos, runs (with their immutable snapshots), registered LoRAs
- `projects/<id>/originals/`: byte-for-byte copies of imported photos
- `projects/<id>/thumbs/`: thumbnails
- `projects/<id>/runs/<id>/dataset/`: the converted training images (PNG, oriented, cropped, no metadata)
- `projects/<id>/runs/<id>/validation/`: validation images downloaded from the host
- `artifacts/`: registered LoRA files
- `known_hosts`: host keys you trusted in the app (your `~/.ssh/known_hosts` is also read, never written)

On the host, under the workspace:

- `runner/`: the app's runner and validation script, replaced when the app's version changes
- `env/`: the training environment, the pinned script, `models.json`, setup status and log
- `hf-cache/`: the base model
- `jobs/<run id>/`: `request.json`, `dataset/`, `train.log`, `status.json`, `output/checkpoint-N/`, `validation/`
- `lock/gpu.lock`: held by the run using the GPU; a second run waits as *queued*

*Clean up on host* removes one run's `jobs/<run id>` folder and nothing else. It is refused while that run is running.

## How a run works

1. **Create.** The included photos are converted (EXIF orientation applied, optional crop, 8-bit RGB, PNG without metadata). The run records a snapshot: each file's hash and caption, the settings, the trainer, the model, and a dataset hash. The snapshot can never change afterwards; SQLite rejects any update to it.
2. **Upload.** Over SFTP. Each file goes to `name.part` first, so an interrupted upload continues where it stopped. The host's SHA-256 of every file is compared with the snapshot before the run counts as uploaded.
3. **Start.** One SSH command runs `<python> <workspace>/runner/runner-1.py start <run uuid>`. Its parts are checked to be plain path characters and a UUID. Captions, prompts and settings travel in `request.json` and on stdin, never on a command line. On the host, captions are written to the trainer's `metadata.jsonl`.
4. **Supervise.** The runner starts a detached supervisor (its own session), so the run keeps going when the app closes or the connection drops. It reads the trainer's progress bar for the real step, loss and pace, and writes `status.json`.
5. **Validate**, then **completed**. A trainer error is classified from its log (out of memory, disk full, missing dependency, missing model) and shown with what to do.

The app checks a run's status when the Training page opens and every 15 seconds while a run is active. A failed check marks the run *as last seen*, not failed. A run whose supervisor disappeared (the host restarted) is reported as interrupted.

**Cancel** stops that run's process group only (SIGTERM, then SIGKILL after 60 s), keeps its checkpoints, and reports the state the host ends in. **Resume** is offered only when a checkpoint holds training state (`optimizer.bin` and `scheduler.bin` beside the LoRA). The final exported LoRA alone cannot be resumed.

Before a run starts, the host check lists GPU memory in use and any processes nvidia-smi reports. Nothing is stopped for you.

## Using a LoRA

1. **Results > Register LoRA** on a checkpoint downloads it, checks it against the host's hash and checks it really is a Qwen-Image 2.1 transformer LoRA. It is then recorded with its family, base model and revision, trainer version, settings, trigger token, dataset hash, step, size, SHA-256 and validation images.
2. **Install for ComfyUI** uploads it to the host's ComfyUI LoRA folder over SFTP as `imagegen-<project>-qwenimage21-step<N>-<hash>.safetensors`, and checks the copy's hash. ComfyUI's HTTP API is never used to write files.
3. **Use in Generate** selects your ComfyUI connection, chooses the LoRA and offers to add the trigger token to the prompt once. In Generate, the *Trained LoRA* field refreshes ComfyUI's LoRA list. It also explains when a workflow has no LoRA loader (it is not added for you), has several unmapped loaders, or loads a different model family. The LoRA and its strength are saved in each generation's metadata.

**Save LoRA** writes the file with its manifest JSON next to it. **Save manifest** writes the manifest alone. Neither includes photographs or credentials.

## A real smoke test

This needs a GPU host. It has not been run as part of the automated tests.

1. Create a project with 4 to 6 photos of one person, with captions that include the trigger token.
2. Under *Advanced*, set steps to 20, the checkpoint and validation interval to 10, and one validation prompt with one seed.
3. *Check host*, *Set up environment* with the model download, wait until setup completes, then *Check host* again until the environment and model show as ready.
4. *Review and start training*, confirm, and watch the step and loss update.
5. When it completes, open *Checkpoints and LoRAs*, register step 20, install it, and use it in Generate with a Qwen-Image 2.1 ComfyUI workflow that has a `LoraLoaderModelOnly` node.
6. Try *Cancel run* on a second run after its first checkpoint, then *Resume*.

## Tests

- `pnpm test`: presets and checks, derived values, caption rules and cancellation, run states (lost connection, failure, resume eligibility), LoRA compatibility and workflow binding.
- `cargo test` in `src-tauri`: project persistence, immutable snapshots, item patches, photo import (orientation, GPS detection, reproducible conversion, crops), path and command checks, request building, LoRA header checks, host keys.
- `python -m unittest discover -s src-tauri/runner`: request checks, trainer arguments, progress and error parsing, checkpoints and resume points. On Linux, it also runs end-to-end tests: start, cancel and resume, a changed dataset refused, and job-only cleanup, driven by a fake trainer.

### Testing the transport

`src-tauri/src/training/transport_test.rs` drives the real SSH and SFTP code against an SSH server, with a fake trainer: unknown-host refusal and trust, runner deployment, a resumed upload, hash checks, start to completion, a caption containing shell syntax that must not run, LoRA download and header check, cleanup, and refusal of paths outside the jobs folder. It is ignored by default. Any SSH server whose workspace has a fake environment will do; see the module notes for the variables. A fake environment is a `env/venv/bin/python` link to `python3`, a `models.json` naming a model folder, and a script at `env/trainers/diffusers-v0.42.1/train_dreambooth_lora_qwenimage21.py` that prints `Steps:` progress lines and writes `checkpoint-N/pytorch_lora_weights.safetensors`.
