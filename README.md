# ImageGen

A desktop app for generating images with several backends from one place:

| Backend | What it talks to |
| --- | --- |
| OpenAI | Images API (`/images/generations`, `/images/edits`) |
| ComfyUI | A ComfyUI server: local, on your network, or on a cloud pod |
| RunPod Serverless | An endpoint running [worker-comfyui](https://github.com/runpod-workers/worker-comfyui) |
| fal.ai | Any model through the queue API |
| Replicate | Any image model; inputs are mapped from the model's schema |
| A1111 / Forge / SD.Next | Stable Diffusion WebUI started with `--api` |

It does text to image, image to image with a painted or uploaded mask, runs your own ComfyUI workflows, and keeps a local gallery of every result with its prompt and settings.

Built with Tauri 2 (Rust) and Next.js 16 (App Router as a static export, React 19, Tailwind 4). The views are real routes (`/`, `/gallery`, `/connections`) that Tauri serves from the exported HTML.

## Running it

Requirements: Node 20+, pnpm, Rust (stable), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (WebView2 is already on Windows 11).

```sh
pnpm install
pnpm tauri dev      # app window with hot reload
pnpm tauri build    # installers in src-tauri/target/release/bundle
```

`pnpm dev` alone serves the UI in a browser, but it needs the Tauri runtime and shows an error there.

## Where things are stored

- **API keys** go to the OS credential store (Windows Credential Manager, macOS Keychain, Secret Service on Linux) under `io.imagegen.desktop`. They are never written to disk by the app.
- **Connections and form state**: `settings.json` in the app data folder.
- **Images**: `images/` plus a `gallery.sqlite3` index in the app data folder (`%APPDATA%\io.imagegen.desktop` on Windows). The gallery's *Open folder* button goes there.

## Masks

*Paint mask* opens a brush over the input image (B brush, E eraser, `[` `]` size, Ctrl Z undo). You can also drop a mask file: white or transparent pixels mark the area to change. Internally a mask is always white-means-change at the input image's size; the OpenAI adapter converts it to the transparent form OpenAI expects. ComfyUI and RunPod inpaint with `SetLatentNoiseMask`; A1111, fal.ai and Replicate get the mask as an image input.

## Credit

The top bar shows the active backend's credit, and each connection's settings page has a *Credit* section. It refreshes when you switch backends, a few seconds after each generation, every 5 minutes, and when you click it. What's available depends on the provider:

| Backend | Shows | Needs |
| --- | --- | --- |
| fal.ai | Balance left | A key with billing read access (Billing, Read-only or Full preset) |
| RunPod | Balance left, current spend per hour, spend limit | A key that can read account data (not one limited to specific endpoints) |
| OpenAI | Spending this month (OpenAI has no balance API) | An optional *Admin key* in the connection, with read access to usage |
| Replicate, ComfyUI, A1111 | Nothing | Replicate's API has no billing endpoint; the others run on your hardware |

A balance under $2, or one RunPod reports as low, shows in red.

## ComfyUI workflows

ComfyUI and RunPod connections can run your own workflow instead of the built-in one. In ComfyUI, use *Workflow > Export (API)*, then import the JSON with the file button next to *Workflow*. The app finds the prompt, negative prompt, seed, steps, guidance, sampler, scheduler, size, batch size, model, input image and mask on its own, and the editor lets you change that or expose any other input (a LoRA strength, a filename prefix) as a panel field. Fields get dropdowns from the server's `/object_info` when it has a list. Inputs you leave alone run exactly as exported.

## Backend notes

- **ComfyUI** uses a built-in checkpoint workflow (checkpoint → KSampler → save), with img2img via `LoadImage` → `ImageScale` → `VAEEncode`. Progress and live previews come over the websocket. Requests go out with no `Origin` header, so ComfyUI's loopback CSRF check passes without `--enable-cors-header`.
- **RunPod** builds the same workflow and sends it to `/run` on your endpoint, then polls `/status`. The checkpoint name must exist inside the worker (baked into the image or on its network volume). Canceling calls `/cancel`.
- **fal.ai / Replicate** read each model's OpenAPI schema and send only the inputs it accepts (`image_size` vs `width`/`height` vs `aspect_ratio`, `num_images` vs `num_outputs`, and so on). Use *Extra input* for model-specific fields.
- **OpenAI**: the model list is read from `/models` once a key is set. Sizes are sent as `WIDTHxHEIGHT`; set *Size* to *Let the model choose* for `auto`.
- **A1111**: a model chosen in the panel is applied with `override_settings`, which switches the server's loaded checkpoint.

## Security

The webview runs under a Content Security Policy (`src-tauri/tauri.conf.json`): scripts only from the app (Tauri hashes Next's inline scripts at build time), images only from the app, the gallery and blob/data URLs, and no network access except Tauri IPC. All backend traffic goes through Rust.

## Layout

```
src/
  app/                  Next.js routes: / (generate), /gallery, /connections
  components/           UI: generate/, gallery/, connections/, shared ui.tsx
  providers/            One file per backend + shared helpers
    types.ts            ProviderDefinition, GenerateParams, ...
    registry.ts         The list of backends
    comfy-workflow.ts   Built-in graph, workflow import, input detection (ComfyUI + RunPod)
    schema-input.ts     Schema-driven input mapping (fal.ai + Replicate)
  lib/                  HTTP (through Rust, no CORS), gallery, masks, secrets, settings
  store/app.ts          App state and the generate flow (zustand)
src-tauri/
  src/gallery.rs        Image files + SQLite index
  src/secrets.rs        OS keychain access
  capabilities/         Webview permissions (HTTP scope, opener, ...)
```

## Adding a backend

1. Write a `ProviderDefinition` in `src/providers/<name>.ts`. It declares its connection fields (fields with `type: "secret"` go to the keychain automatically), its capabilities (which controls the panel shows), extra options, `testConnection` and `generate`.
2. Add it to `PROVIDERS` and `PROVIDER_ORDER` in `src/providers/registry.ts`, and its kind to `ProviderKind` in `types.ts`.

`generate` receives neutral params, an `AbortSignal` and an `onProgress` callback, and returns image bytes. Saving to the gallery is handled for it.
