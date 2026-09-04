import path from "path";

// Stable Diffusion API URL - ★ポート番号を7860に修正★
export const SD_API_URL = process.env.SD_API_URL || "http://127.0.0.1:7860";

// Output directory for generated images - ★パスを直接指定に修正★
export const OUTPUT_DIR = "C:\\SD_Output"; // Windowsのパス区切り文字'\'は二重'\\'にするか、'/'を使用

// When true, automatically prepend standard negative prompts to every generation
export const USE_DEFAULT_NEGATIVE_PROMPT = true;

// Standard negative prompt terms that improve output quality
export const DEFAULT_NEGATIVE_PROMPTS = [
  "bad_anatomy",
  "bad_quality",
  "ugly",
  "watermark",
  "text",
  "deformed",
  "extra_fingers",
  "bad_hands",
  "blurry",
  "low_quality",
  "worst_quality",
  "signature",
  "cropped",
  "jpeg_artifacts",
];

// When true, send the full-resolution image as a compressed JPEG in the response.
// When false, send a 512px thumbnail PNG instead (smaller payload).
// Recommended: true for LM Studio, false for Claude Desktop.
export const SEND_FULL_IMAGE_BASE64 = true;

// Default image generation parameters optimized for SDXL (1024x1024)
export const DEFAULT_PARAMS = {
  width: 832,
  height: 1216,
  steps: 24,
  cfg_scale: 7,
  sampler_index: "Euler a",
  negative_prompt: "bad_anatomy, bad_quality, watermark, text, deformed, blurry, low_quality, ugly, man, Stable_Yogis_Animetoon_Negatives-neg",
  seed: -1
};

// Hard ceiling for a single generation request to the WebUI, in milliseconds.
// A large SDXL render with hi-res fix on a busy GPU can legitimately take
// several minutes, so this is generous by default.
export const GENERATION_TIMEOUT_MS = Number(process.env.SD_GENERATION_TIMEOUT_MS ?? 600000);

// How long a generation tool blocks before handing back a job id instead.
//
// The default is the full generation timeout: the tool simply waits for the
// image, which is what any MCP client with a reasonable request deadline wants.
//
// The handoff exists because some clients impose their own deadline that the
// server cannot see or change (the MCP TypeScript SDK's default is 60s, and not
// every host exposes a setting for it). When a client stops listening, the
// render is NOT lost — it continues here and check-generation collects it. So
// this value is not a timeout to tune defensively; it only decides whether the
// image comes back on the first call or the second.
//
// Lower it only if you would rather have an early job id than a request your
// client will abandon anyway — setting it just under a known client deadline
// turns a dropped result into a clean "call check-generation" handoff.
export const GENERATION_WAIT_SECONDS = Number(
  process.env.SD_GENERATION_WAIT_SECONDS ?? Math.round(GENERATION_TIMEOUT_MS / 1000)
);
