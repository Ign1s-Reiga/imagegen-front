# ImageGen

A desktop app for generating images with several backends from one place:

| Backend | What it talks to |
| --- | --- |
| OpenAI | Images API (`/images/generations`, `/images/edits`) |
| OpenRouter | Image models from many labs through its Image API, and chat models for the assistant |
| ComfyUI | A ComfyUI server: local, on your network, or on a cloud pod |
| RunPod Serverless | An endpoint running [worker-comfyui](https://github.com/runpod-workers/worker-comfyui) |
| fal.ai | Any model through the queue API |
| Replicate | Any image model; inputs are mapped from the model's schema |
| A1111 / Forge / SD.Next | Stable Diffusion WebUI started with `--api` |
| Claude | The Claude API, for the prompt helper and the pixel assistant (Claude does not make images) |

It does text to image (with reference images attached to the prompt, like a chat message), image to image with a painted or uploaded mask, runs your own ComfyUI workflows, and keeps a local gallery of every result with its prompt and settings. A pixel editor turns the same backends into a sprite tool. With a Claude or OpenRouter connection, a prompt helper rewrites prompts for the model you use, and a pixel assistant draws and edits sprites from a chat.

Built with Tauri 2 (Rust) and Next.js 16 (App Router as a static export, React 19, Tailwind 4). The views are real routes (`/`, `/pixel`, `/gallery`, `/connections`) that Tauri serves from the exported HTML.

## Running it

Requirements: Node 20+, pnpm, Rust (stable), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (WebView2 is already on Windows 11).

```sh
pnpm install
pnpm tauri dev      # app window with hot reload
pnpm tauri build    # installers in src-tauri/target/release/bundle
```

`pnpm dev` alone serves the UI in a browser, but it needs the Tauri runtime and shows an error there.

Checks (the same ones CI runs on every push to `main` and every pull request):

```sh
pnpm lint
pnpm typecheck      # generates Next's route types, then runs tsc
pnpm test           # unit tests with Node's test runner (src/**/*.test.ts)
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

CI runs the Rust checks on Linux and Windows.

## Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`. It builds the Windows installers (NSIS `.exe` and `.msi`) and attaches them to a **draft** GitHub Release, so nothing is public until you publish the draft. The changelog is generated from the merged pull requests, which is the same text GitHub's "Generate release notes" button would give.

To cut a release:

1. Set the same version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then refresh `Cargo.lock` (for example with `cargo check` in `src-tauri`). Merge that change.
2. Tag `main` and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. When the workflow finishes, review the draft under Releases and publish it.

If the tag doesn't match those three versions, the workflow stops before building, since the installers are named after the app version and not the tag. You can also run the workflow by hand from the Actions tab: it releases the current version under an `app-v<version>` tag.

## Where things are stored

- **API keys** go to the OS credential store (Windows Credential Manager, macOS Keychain, Secret Service on Linux) under `io.imagegen.desktop`. They are never written to disk by the app.
- **Connections and form state**: `settings.json` in the app data folder.
- **Images**: `images/` plus a `gallery.sqlite3` index in the app data folder (`%APPDATA%\io.imagegen.desktop` on Windows). The gallery's *Open folder* button goes there.

## Masks

*Paint mask* opens a brush over the input image (B brush, E eraser, `[` `]` size, Ctrl Z undo). You can also drop a mask file: white or transparent pixels mark the area to change. Internally a mask is always white-means-change at the input image's size; the OpenAI adapter converts it to the transparent form OpenAI expects. ComfyUI and RunPod inpaint with `SetLatentNoiseMask`; A1111, fal.ai and Replicate get the mask as an image input.

## Reference images

Paste, drop or attach images in the prompt box, or attach a result with the paperclip on its action bar, and they go to the model with the prompt in the order shown; the numbers on the thumbnails match "image 1", "image 2" in the prompt. In image to image the input image goes first and the references follow.

| Backend | Sent as |
| --- | --- |
| OpenAI | The edits endpoint with several `image[]` parts (GPT Image models, up to 16) |
| OpenRouter | `input_references` (up to 16) |
| fal.ai, Replicate | The model's list image input (`image_urls`, `input_images`, ...), or its single image input for one reference; pick an edit model that takes images |
| ComfyUI, RunPod, A1111 | Not supported; Generate says so instead of leaving them out |

## Credit

The top bar shows the active backend's credit, and each connection's settings page has a *Credit* section. It refreshes when you switch backends, a few seconds after each generation, every 5 minutes, and when you click it. What's available depends on the provider:

| Backend | Shows | Needs |
| --- | --- | --- |
| fal.ai | Balance left | A key with billing read access (Billing, Read-only or Full preset) |
| RunPod | Balance left, current spend per hour, spend limit | A key that can read account data (not one limited to specific endpoints) |
| OpenAI | Spending this month (OpenAI has no balance API) | An optional *Admin key* in the connection, with read access to usage |
| OpenRouter | Spending this month on the key; balance left | The API key; the balance needs an optional *Management key* |
| Replicate, ComfyUI, A1111, Claude | Nothing | Replicate's and Claude's APIs have no balance endpoint for regular keys; the others run on your hardware |

A balance under $2, or one RunPod reports as low, shows in red.

## Pixel editor

*Pixel* is a sprite editor (up to 256×256) with layers, animation frames and a palette, plus three AI tools that use the active backend with the model and settings from *Generate*:

| Tool | What it does |
| --- | --- |
| Create | Generates a sprite from a description |
| Edit area | Redraws the selected area of the current layer. Backends without masks redraw the whole sprite and keep only the area |
| Variations | Generates new versions of the current frame, e.g. other poses for animation frames |

Models draw "pixel art" with soft, uneven fake pixels, so every result is snapped back to the sprite: the image is cropped to the sprite's shape, and each sprite pixel takes the palette colour most of the pixels near its centre are closest to (in OKLab). The palette is the sprite's own, or a new one picked from the result. Sprites are sent to the model flattened onto a colour that is far from the palette, and that colour comes back as transparency; a background that reaches the edges can be cleared too. Results can be added as a new layer or frame, or replace the current layer, and the raw images also go to the gallery.

Tools: pencil (B), eraser (E), fill (G), pick colour (I, or Alt click), line (L), rectangle (U), select (M), move (V), mirror left/right and top/bottom. Right click draws with the secondary colour. Ctrl Z / Ctrl Shift Z undo and redo, Ctrl A / Esc select all or nothing, Delete clears the selection, `[` `]` brush size, X swaps colours, `,` `.` step frames, Enter plays, Space drag or middle drag pans, the wheel zooms, 0 fits. Ctrl Enter runs the image tool (in the *Image tools* tab), Ctrl S saves.

The *Colour* panel edits the primary or secondary colour (click a swatch to pick which): drag on the saturation/value area and the hue strip, or type HSV, RGB or hex (`#48c` shorthand works). Arrow keys step the area, the strip and the fields, ten at a time with Shift. Double click a palette swatch to edit it the same way.

The sprite is kept between sessions automatically (`pixel.json` in the app data folder). *Save* writes a `.pixel` project file (JSON with every layer and frame); *Open* reads those or a PNG/GIF/WebP up to 256×256; *Export* writes the current frame or a sprite sheet as PNG at 1× to 16×. The save dialog runs in Rust, so the webview never picks the path it writes to.

## Assistant: prompt helper and pixel assistant

A Claude or OpenRouter connection adds two things. The chat model is chosen at the top of the pixel assistant (Claude defaults to `claude-opus-5-5`, OpenRouter to `anthropic/claude-opus-5.5`), and the prompt helper uses the same one.

- **Prompt helper.** *Improve* next to a prompt rewrites it for the model you are about to use: comma-separated phrases for Stable Diffusion checkpoints, plain sentences for FLUX, GPT Image, Gemini and similar, plus a negative prompt where the backend takes one. For sprites it describes only the subject, since the pixel tools add the style words. *Undo* puts your prompt back.
- **Pixel assistant.** The *Assistant* tab of the Pixel page is a chat with a model that edits the open sprite through tools: it reads the sprite (as an image, or as a grid of palette characters for exact pixels), draws pixels, lines, rectangles and fills, manages the palette, layers and frames, and can start a new sprite. When an image backend is connected it can also run the image tools and place a result. Everything it changes for one message is one undo step, and *Stop* ends it mid-reply.

Claude is called through Anthropic's official TypeScript SDK, with the app's Rust HTTP client underneath, so it follows the same no-network webview rule as everything else. Requests use adaptive thinking, prompt caching for the system prompt and tools, and (on Claude Fable 5.1, Opus 5.5, Opus 5 and Sonnet 5.5 at the official endpoint) Anthropic's server-side fallback, which retries a request a model declines on another model. OpenRouter is called through its chat completions API, and the model's reasoning details are sent back with each turn.

Each assistant message can take several model calls (one per round of tool use, up to 40), each billed by the provider.

## ComfyUI workflows

ComfyUI and RunPod connections can run your own workflow instead of the built-in one. In ComfyUI, use *Workflow > Export (API)*, then import the JSON with the file button next to *Workflow*. The app finds the prompt, negative prompt, seed, steps, guidance, sampler, scheduler, size, batch size, model, input image and mask on its own, and the editor lets you change that or expose any other input (a LoRA strength, a filename prefix) as a panel field. Fields get dropdowns from the server's `/object_info` when it has a list. Inputs you leave alone run exactly as exported.

## Backend notes

- **ComfyUI** uses a built-in checkpoint workflow (checkpoint → KSampler → save), with img2img via `LoadImage` → `ImageScale` → `VAEEncode`. Progress and live previews come over the websocket. Requests go out with no `Origin` header, so ComfyUI's loopback CSRF check passes without `--enable-cors-header`.
- **RunPod** builds the same workflow and sends it to `/run` on your endpoint, then polls `/status`. The checkpoint name must exist inside the worker (baked into the image or on its network volume). Canceling calls `/cancel`.
- **fal.ai / Replicate** read each model's OpenAPI schema and send only the inputs it accepts (`image_size` vs `width`/`height` vs `aspect_ratio`, `num_images` vs `num_outputs`, and so on). Use *Extra input* for model-specific fields.
- **OpenAI**: the model list is read from `/models` once a key is set. Sizes are sent as `WIDTHxHEIGHT`; set *Size* to *Let the model choose* for `auto`.
- **OpenRouter** uses its Image API (`/images`). There is no default image model; pick one in the *Model* field, which lists every image model the key can use. Width and height are sent as the nearest aspect ratio plus a 1K, 2K or 4K tier, each image is its own request (many models make one image per call), and image to image sends the input as a reference. There are no masks, so the pixel editor's *Edit area* redraws the whole sprite and keeps the selected area. Each request is fitted to what the model lists: settings it does not take are left out (with a notice when you chose them), and the aspect ratio and resolution snap to ones it has. *Moderation: low* goes only to providers that accept it as a pass-through (OpenAI's image models); for other models it is not sent.
- **A1111**: a model chosen in the panel is applied with `override_settings`, which switches the server's loaded checkpoint.

## Security

The webview runs under a Content Security Policy (`src-tauri/tauri.conf.json`): scripts only from the app (Tauri hashes Next's inline scripts at build time), images only from the app, the gallery and blob/data URLs, and no network access except Tauri IPC. All backend traffic goes through Rust.

## Layout

```
src/
  app/                  Next.js routes: / (generate), /pixel, /gallery, /connections
  components/           UI: generate/, pixel/, gallery/, connections/, shared ui.tsx
  assistant/            Prompt helper and the assistant's connection settings
  pixel/                Sprite model, drawing, palettes, snapping AI output to the grid, AI tools
    agent.ts            Pixel assistant: chat loop, image tools, undo grouping
    agent-tools.ts      The assistant's editing tools (validated with zod)
  providers/            One file per backend or service + shared helpers
    types.ts            ServiceDefinition, ProviderDefinition, GenerateParams, ...
    chat.ts             Provider-neutral chat turns, tools and replies
    anthropic.ts        Claude (official SDK) and its message conversion in anthropic-format.ts
    openrouter.ts       OpenRouter images, chat and credit; conversions in openrouter-format.ts
    registry.ts         The list of backends and services
    comfy-workflow.ts   Built-in graph, workflow import, input detection (ComfyUI + RunPod)
    schema-input.ts     Schema-driven input mapping (fal.ai + Replicate)
  lib/                  HTTP (through Rust, no CORS), gallery, masks, secrets, settings
  store/app.ts          App state and the generate flow (zustand)
src-tauri/
  src/gallery.rs        Image files + SQLite index
  src/secrets.rs        OS keychain access
  src/files.rs          Save dialog + file write for sprite exports
  capabilities/         Webview permissions (HTTP scope, opener, ...)
```

## Adding a backend

1. Write a `ProviderDefinition` in `src/providers/<name>.ts`. It declares its connection fields (fields with `type: "secret"` go to the keychain automatically), its capabilities (which controls the panel shows), extra options, `testConnection` and `generate`.
2. Add it to `PROVIDERS` and `SERVICE_ORDER` in `src/providers/registry.ts`, and its kind to `ProviderKind` in `types.ts`.

`generate` receives neutral params, an `AbortSignal` and an `onProgress` callback, and returns image bytes. Saving to the gallery is handled for it.

A service with chat models (like Claude, which makes no images) is a `ServiceDefinition` with a `chat` part instead: list it in `SERVICES` and `SERVICE_ORDER`, and add its kind to `ConnectionKind`. Its `send` converts the neutral turns in `chat.ts` to its API and back; an image backend can have a `chat` part too, as OpenRouter does.
