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
  width: 1024, // ← 1024 のまま
  height: 1024, // ← 1024 のまま
  steps: 30,
  cfg_scale: 7,
  sampler_index: "Euler a",
  negative_prompt: "",
  seed: -1
};