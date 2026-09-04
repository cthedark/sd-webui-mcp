# SD WebUI MCP Server (fork)

An MCP (Model Context Protocol) server that connects Claude Desktop to your local Stable Diffusion WebUI installation, enabling AI-assisted image generation directly from your conversations.

## 🔋 Overview

This project allows you to utilize your local Stable Diffusion installation through Claude Desktop, giving you the ability to:

* Generate images from text descriptions
* Edit existing images with text prompts
* List and switch between different Stable Diffusion models
* Access advanced image generation parameters
* View image thumbnails directly in Claude responses

All while staying within the Claude Desktop interface, without switching between applications.

## 🎯 Features

* **Text-to-Image Generation**: Create images from text prompts
* **Image-to-Image Editing**: Modify existing images using text guidance
* **Model Management**: List and switch between your installed models
* **Sampler Control**: Access all WebUI samplers
* **Connection Status**: Verify connectivity with your local Stable Diffusion
* **High Performance**: Uses your local GPU resources for image generation
* **Privacy-Focused**: All processing happens on your machine
* **Base64 Thumbnails**: See images directly in Claude responses
* **SDXL Optimized**: Default settings tuned for SDXL's 1024x1024 resolution
* **Hi-Res Fix Support**: Optional upscaling pass for higher quality output
* **Smart Negative Prompts**: Automatically includes standard quality-improving negative prompts, with deduplication
* **Renders Are Never Lost**: Every generation is a tracked job, so if a client abandons the request the result is still collected with `check-generation`
* **LoRA Support**: List installed LoRAs with aliases, base model and likely trigger words; apply them by name and the `<lora:...>` tags are built for you
* **Extension Discovery**: See which extensions and scripts the WebUI has loaded, and inspect a script's argument list
* **Upscaling**: Pure upscaler passes via the Extras tab (ESRGAN / R-ESRGAN / SwinIR / DAT / 4x-UltraSharp …), with optional face restoration
* **ADetailer-Neo**: Typed detailing passes wired into both generation tools, with detector names validated against the live dropdown, plus a raw `alwayson_scripts` escape hatch for any other extension
* **Forge VAE / Text Encoder Control**: Inspect and change `forge_additional_modules` — the same global setting the WebUI's own tab uses

## 📦 Prerequisites

* Node.js v22.0.0 or higher
* Stable Diffusion WebUI with API enabled
* Claude Desktop
* Basic familiarity with command line interfaces

## 🚀 Installation

### 1. Clone this repository

```bash
git clone https://github.com/cthedark/sd-webui-mcp.git
cd sd-webui-mcp
```

### 2. Install dependencies

```bash
npm install
```

### 3. Build the project

```bash
npm run build
```

### 4. Configure Stable Diffusion WebUI

Make sure your Stable Diffusion WebUI is running with the API enabled.

#### For Windows:

Edit your `webui-user.bat` file and add `--api` to the COMMANDLINE_ARGS:

```
@echo off
set COMMANDLINE_ARGS=--api
call webui.bat
```

#### For Linux/macOS:

Edit your `webui-user.sh` file and add `--api` to the COMMANDLINE_ARGS:

```bash
export COMMANDLINE_ARGS="--api"
./webui.sh
```

### 5. Configure Claude Desktop

1. Open Claude Desktop
2. Go to Settings
   * Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   * macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
3. Add the following to the `claude_desktop_config.json` file (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "stable-diffusion": {
      "command": "node",
      "args": [
        "/FULL/PATH/TO/sd-webui-mcp/dist/index.js"
      ]
    }
  }
}
```

**Important**: Replace `/FULL/PATH/TO/` with the actual full path to your project directory. For Windows users, use double backslashes (`\\`) or forward slashes (`/`) in your path.

4. Save the file and restart Claude Desktop

## ⚙️ Usage

### Step 1: Verify installation

After starting Claude Desktop, you should see a tools icon (🔧) in the bottom right corner of the chat interface. Click on it to see if "stable-diffusion" appears in the list of available tools.

### Step 2: Check connection

Type the following message to Claude:

```
Can you check if Stable Diffusion is connected properly?
```

Claude should use the `check-status` tool to verify the connection with your local Stable Diffusion WebUI.

### Step 3: Generate your first image

Type something like:

```
Please create an image of a futuristic city with flying cars.
```

Claude will use the `generate-image` tool to send your request to Stable Diffusion and display the resulting image.

### Advanced Usage

The MCP server provides several tools that Claude can use:

#### 1. Image Generation

```
Generate an image of a cat wearing a space suit on Mars.
```

You can add more detailed parameters:

```
Generate an image of a mountain landscape with the following parameters:
- Width: 1024
- Height: 1024
- Steps: 30
- CFG Scale: 8
- Negative prompt: blurry, low quality
```

You can also enable hi-res fix for higher quality upscaled output:

```
Generate an image of a detailed fantasy castle with hi-res fix enabled.
```

Hi-res fix parameters can be customized:

```
Generate an image of a portrait with these settings:
- Enable hi-res fix: true
- Hi-res scale: 2.0
- Hi-res upscaler: Latent
- Hi-res denoising strength: 0.5
- Hi-res second pass steps: 15
```

#### 1b. Hi-res fix and `hr_additional_modules`

On Forge Neo, any `enable_hr` request **must** include `hr_additional_modules` as a list.
The field is declared `hr_additional_modules: list = field(default=None)` and then
iterated without a `None` check, so omitting it crashes the WebUI mid-request with:

```
File "modules_forge\main_entry.py", line 160, in modules_change
    for v in module_values:
TypeError: 'NoneType' object is not iterable
```

The server always sends it when hi-res fix is on. By default it sends the
`"Use same choices"` sentinel, which makes `processing.py` skip `modules_change`
entirely so the second pass inherits the loaded VAE / Text Encoder with no model reload.

Override it with `hr_modules` when you want something else:

| `hr_modules` | Effect |
|---|---|
| omitted | `["Use same choices"]` — reuse the first pass's modules (default) |
| `[]` | fall back to the checkpoint's built-in VAE / text encoders |
| `["clip_l", "sdxl_vae"]` | load these for the second pass (names resolved via `list-vae-modules`) |

#### 2. Model Switching

First, check available models:

```
What Stable Diffusion models are available on my system?
```

Then switch models:

```
Please switch to the AnythingV5 model.
```

#### 3. Editing Existing Images

Save an image to your system, then:

```
Edit the image at C:/path/to/image.png to add flowers in the background.
```

#### 4. List Sampling Methods

```
What samplers are available in my Stable Diffusion setup?
```

#### 5. LoRAs

`list-loras` reads `/sdapi/v1/loras` and reports each LoRA's name, alias, base model
version and its most frequent training tags (a best-effort guess at trigger words,
parsed from `ss_tag_frequency` in the safetensors metadata).

```
What LoRAs do I have installed?
Show me only the ones with "detail" in the name.
```

You do not have to write `<lora:...>` tags yourself. Pass LoRAs structurally and the
server resolves partial names against the installed list, then appends the tags to the
prompt:

```
Generate a portrait using the detail tweaker LoRA at 0.7 and my style LoRA at 0.5.
```

which becomes:

```jsonc
{
  "prompt": "a portrait",
  "loras": [
    { "name": "detail_tweaker_xl", "weight": 0.7 },
    { "name": "myStyle_v2", "weight": 0.5, "te_weight": 0.3 }
  ]
}
```

Names are matched exactly first, then case-insensitively, then by unique substring.
An ambiguous name is an error listing the candidates rather than a guess. `refresh-loras`
rescans the directory after you drop in a new file, without restarting the WebUI.

> `/sdapi/v1/loras` is registered by the built-in **Lora** extension rather than core
> `api.py`. If it 404s, that built-in has been disabled.

#### 6. Extensions

```
What extensions are installed?
What arguments does the ADetailer script take?
```

`list-extensions` combines `/sdapi/v1/extensions`, `/sdapi/v1/scripts` and
`/sdapi/v1/script-info`. Use it to confirm the exact script names this build accepts in
`alwayson_scripts` before wiring anything up, and pass `script_details` to dump a
script's positional argument list. Script name matching in the WebUI is case-insensitive,
so `ADetailer` and `adetailer` both work.

#### 7. Upscaling

`upscale-image` uses the **Extras** tab (`/sdapi/v1/extra-single-image`) — a pure
upscaler pass with no diffusion, so nothing in the image changes except resolution.

```
List my upscalers.
Upscale C:/SD_Output/sd_image_....png 2x with 4x-UltraSharp.
```

Two resize modes are supported: `multiplier` (scale by `scale`) and `dimensions`
(target `target_width` × `target_height`, optionally cropping to fit). You can blend a
second upscaler, and apply GFPGAN or CodeFormer face restoration in the same pass.

The upscaler name is validated against `/sdapi/v1/upscalers` before the request is sent,
because the extras endpoint silently no-ops on an unknown name — which otherwise looks
exactly like success.

For a *creative* upscale that adds detail rather than just pixels, use `generate-image`
with `enable_hr`, or `edit-image` at a low denoising strength.

#### 8. ADetailer (ADetailer-Neo)

Targets [ADetailer-Neo](https://github.com/Haoming02/ADetailer-Neo), the maintained fork
for Forge Neo. Start by seeing what detectors are installed:

```
What ADetailer detectors do I have?
```

`list-adetailer-models` reads the live dropdown choices out of `/sdapi/v1/script-info`,
so it reflects whatever is actually in `models/adetailer/` rather than a hardcoded list.

Both `generate-image` and `edit-image` accept an `adetailer` array — one entry per
detection pass — which is translated into the positional payload the extension expects
(`[enable, skip_img2img, unit, unit, …]`):

```jsonc
{
  "prompt": "a knight in a forest",
  "adetailer": [
    { "model": "face_yolov8n.pt", "prompt": "detailed face", "denoising_strength": 0.35 },
    { "model": "hand_yolov8n.pt", "denoising_strength": 0.3, "mask_k": 2 }
  ]
}
```

Detector names are resolved from partial input (`"hand"` → `hand_yolov8n.pt`) and an
ambiguous or unknown name is rejected with the candidates listed. **This validation
matters**: Neo declares its `ADetailerArgs` model as `extra="forbid"` and its
`need_skip()` treats an unrecognised model as "skip this unit", so a bad name produces a
successful-looking generation that quietly has no detailing at all. The server only ever
emits keys that exist on `ADetailerArgs`, for the same reason.

Supported per-unit fields, all optional except `model`:

| Group | Fields |
|---|---|
| Detection | `model`, `model_classes`, `confidence`, `mask_filter_method`, `mask_k`, `mask_min_ratio`, `mask_max_ratio` |
| Mask shaping | `dilate_erode`, `x_offset`, `y_offset`, `mask_merge_invert`, `mask_blur` |
| Inpainting | `prompt`, `negative_prompt`, `denoising_strength`, `inpaint_only_masked`, `inpaint_only_masked_padding`, `inpaint_width`, `inpaint_height` |
| Per-pass overrides | `steps`, `cfg_scale`, `checkpoint`, `vae`, `sampler`, `scheduler`, `noise_multiplier` |
| Misc | `restore_face`, `enabled` |

Anything left unset is omitted from the payload so ADetailer applies its own default.
The paired `ad_use_*` gate flags are set for you — passing `steps: 24` sends both
`ad_use_steps: true` and `ad_steps: 24`.

#### 8b. Other extensions

ControlNet is deliberately **not** modelled here: model names and preprocessors change
with whatever ControlNet you have loaded, so a typed wrapper would be wrong more often
than right. Use `extra_alwayson_scripts` to pass any extension's payload straight
through:

```jsonc
{
  "extra_alwayson_scripts": {
    "ControlNet": { "args": [{ "enabled": true, "module": "canny", "model": "…", "image": "<base64>" }] },
    "Self Attention Guidance": { "args": [true, 0.75, 2.0] }
  }
}
```

`list-extensions` with `script_details` gives you the argument order for any script.
Script name matching in the WebUI is case-insensitive.

#### 9. VAE / Text Encoder modules (Forge)

```
What VAE and text encoders are loaded right now?
Load clip_l and t5xxl_fp16 as well.
```

* `list-vae-modules` — every module Forge has discovered, with the loaded ones marked
* `set-vae-modules` — change the selection (`replace` or `add`)
* `get-sd-settings` — current checkpoint, modules, CLIP skip and related global settings

**Does this "stick"?** Yes. The selection lives in `shared.opts.forge_additional_modules`,
a single global setting inside the running WebUI process. Consequences:

* Whatever the host loaded in its own browser tab **is** the active selection for API
  requests too. There is nothing to re-send per generation, and nothing to re-load.
* Writing it through `POST /sdapi/v1/options` is persistent: it applies to every later
  request and is flushed to `config.json`, so it survives a WebUI restart.
* The *non*-sticky alternative is `override_settings` inside a txt2img/img2img payload,
  which the WebUI reverts once the request finishes
  (`override_settings_restore_afterwards` defaults to `true`). That is the right tool for
  a one-off and the wrong tool for "load this and keep it".
* Because the state is shared, changing it from here also changes what the host's UI is
  using. The already-open browser tab may need a refresh to *display* the new value, but
  the running process has already switched.
* Changing the selection forces Forge to drop and rebuild the loaded model, which costs
  real seconds — so `set-vae-modules` compares against the current value first and does
  nothing when they already match.

`/sdapi/v1/sd-modules` is Forge-specific. On stock AUTOMATIC1111 the nearest equivalent is
the single `sd_vae` setting, which follows the same persistence rules.

## ⏱️ Long generations

A generation request to the WebUI is allowed **10 minutes** (`GENERATION_TIMEOUT_MS`),
and by default the tool waits that long for the image and returns it inline. On any MCP
client with a reasonable request deadline, that is all you need to know.

Underneath, every generation is registered as a **job**, which makes a render impossible
to lose. Two things can end the tool call before the image is ready:

* the wait window (`GENERATION_WAIT_SECONDS`) elapsing, or
* the **client** hitting its own request deadline — one the server can neither see nor
  change. The MCP TypeScript SDK defaults to 60s, and not every host exposes a setting
  for it.

In both cases the WebUI keeps rendering and the result is held here for an hour:

```
generate-image   → "Still rendering after 60s… Job id: txt2img-a1b2c3d4, Progress: 62%"
check-generation → [the image]
```

`check-generation` with no arguments picks up the job you are most likely waiting on, so
in practice it is just "call it again". `list-generations` shows everything started this
session and whether it has been collected; `cancel-generation` interrupts the running render.

**Tuning.** `wait_seconds` (per call) and `SD_GENERATION_WAIT_SECONDS` (server-wide)
control only *when* you get a job id instead of the image — never whether the render
completes. Lower them if your client abandons requests early and you would rather have a
clean handoff than a request the client drops; there is no reason to lower them otherwise.

| Client | Notes |
|---|---|
| Any client with a generous or configurable deadline | Defaults are fine — images return inline. |
| Claude Code | Honours a per-server `timeout` (ms) in `.mcp.json` and `MCP_TOOL_TIMEOUT`. |
| Claude Desktop | Hardcoded ~60s, not configurable. Renders past that come back via `check-generation`; set `SD_GENERATION_WAIT_SECONDS=55` if you prefer the handoff over a dropped request. |

The server also emits `notifications/progress` while waiting, when the client supplies a
progress token. That does not extend a hard request deadline, but it does reset the
*idle* timeout some clients apply, and it surfaces the percentage where supported.

> **Note on retries:** a timeout is never retried. The request reached the WebUI and the
> GPU is busy with that job, so a retry would queue a duplicate render behind it rather
> than recover from anything. Only connection-level failures — the WebUI still starting
> up, a reset socket — are retried.

## 🔧 Configuration

You can customize the behavior of the MCP server by modifying `src/config.ts`:

* `SD_API_URL`: The URL of your Stable Diffusion WebUI API (default: http://127.0.0.1:7860)
* `OUTPUT_DIR`: Directory where generated images will be saved (default: C:\\SD_Output)
* `DEFAULT_PARAMS`: Default image generation parameters optimized for SDXL (1024x1024 resolution)
* `USE_DEFAULT_NEGATIVE_PROMPT`: When `true` (default), automatically prepends standard negative prompts (e.g. `bad_anatomy`, `bad_quality`, `ugly`, `watermark`, etc.) to every generation. User-supplied negative prompts are merged and deduplicated.
* `DEFAULT_NEGATIVE_PROMPTS`: The list of default negative prompt terms. Can be customized to suit your preferred models.
* `GENERATION_TIMEOUT_MS`: Hard ceiling for one generation request to the WebUI (default: 600000, i.e. 10 minutes). Override with `SD_GENERATION_TIMEOUT_MS`.
* `GENERATION_WAIT_SECONDS`: How long a generation tool waits for the image before handing back a job id instead (default: the full generation timeout, i.e. 600s). Override with `SD_GENERATION_WAIT_SECONDS`. This never affects whether a render completes — only whether you collect it on the first call or via `check-generation`.

After modifying, rebuild the project with `npm run build`.

## 🔍 Troubleshooting

### Common Issues

#### MCP server not found in Claude Desktop

* Verify the path in `claude_desktop_config.json` is correct
* Ensure you've included the full absolute path to the `dist/index.js` file
* Check if the Node.js path is correct

#### Cannot connect to Stable Diffusion WebUI

* Make sure Stable Diffusion WebUI is running
* Verify that it was started with the `--api` flag
* Check if the default port (7860) is being used or if you need to specify a custom port in `config.ts`

#### Images not being generated

* Check the output directory exists and has write permissions
* Look for error messages in the Claude Desktop console
* Try running the `check-status` tool to verify connectivity

### Debugging

If you're experiencing issues, you can enable more verbose logging by:

1. Running the MCP server directly from the command line to see error messages:

```bash
node dist/index.js
```

2. You can also use the MCP Inspector for debugging:

```bash
npx @modelcontextprotocol/inspector node /path/to/sd-webui-mcp/dist/index.js
```

## 📝 License

MIT License

## ⚠️ Disclaimer

This project is not officially affiliated with Anthropic (creators of Claude) or Stable Diffusion. Use at your own risk.