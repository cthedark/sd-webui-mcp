// src/tools/alwayson.ts
//
// Typed support for `alwayson_scripts` — the mechanism by which extensions hook
// into a txt2img/img2img request.
//
// Targets ADetailer-Neo (https://github.com/Haoming02/ADetailer-Neo), the
// maintained fork for Forge Neo. Its argument layout matches the original
// extension's:
//
//   { "ADetailer": { "args": [enable, skip_img2img, unit, unit, …] } }
//
// where args[0] is the global enable flag, args[1] is skip_img2img, and every
// remaining dict is one detection pass.
//
// The important behavioural difference from the old extension: Neo validates
// each unit with a pydantic model declared `extra="forbid"`, and a unit that
// fails validation is logged to the WebUI console and SILENTLY DROPPED — the
// generation still succeeds, it just quietly has no detailing. Two consequences
// shape this file:
//
//   1. Only keys that exist on Neo's ADetailerArgs are ever emitted, and any
//      key the caller did not set is omitted entirely so Neo applies its own
//      default rather than receiving a null.
//   2. `ad_model` is validated against the live dropdown choices before the
//      request is sent, because Neo's need_skip() also treats an unknown or
//      "None" model as "skip this unit" — which is indistinguishable from
//      success at the API level.

import { z } from "zod";
import { StableDiffusionAPI } from "../api/sd-api.js";
import { SD_API_URL } from "../config.js";

const api = new StableDiffusionAPI(SD_API_URL);

/** Script title as registered by ADetailer-Neo. WebUI matching is case-insensitive. */
export const ADETAILER_SCRIPT_NAME = "ADetailer";

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/**
 * Pull the ad_model dropdown choices out of /sdapi/v1/script-info. ADetailer
 * registers one dropdown per unit (ad_max_models, default 2), so the choices
 * are unioned across all of them.
 *
 * Returns an empty array when the info cannot be read, in which case callers
 * pass the model name through unvalidated rather than blocking the request.
 */
export async function fetchAdetailerModels(): Promise<string[]> {
  let info;
  try {
    info = await api.getScriptInfo();
  } catch (error) {
    console.error("Could not read script-info for ADetailer model validation:", error);
    return [];
  }

  const script = info.find(s => s.name?.toLowerCase() === ADETAILER_SCRIPT_NAME.toLowerCase());
  if (!script) return [];

  const models = new Set<string>();
  for (const arg of script.args ?? []) {
    if (!Array.isArray(arg.choices)) continue;
    const choices = arg.choices.map(String);
    // The detector dropdown is the one offering "None" plus YOLO (.pt) or
    // MediaPipe (.tflite / mediapipe_*) entries.
    const looksLikeDetectorList =
      choices.includes("None") &&
      choices.some(c => /\.(pt|tflite)$/i.test(c) || /^mediapipe/i.test(c));
    if (!looksLikeDetectorList) continue;
    for (const choice of choices) {
      if (choice !== "None") models.add(choice);
    }
  }

  return [...models];
}

/** Resolve a user-supplied detector name against the live list. */
function resolveAdetailerModel(requested: string, available: string[]): string {
  if (available.length === 0) return requested; // validation unavailable; trust the caller

  const exact = available.find(m => m === requested);
  if (exact) return exact;

  const ci = available.filter(m => m.toLowerCase() === requested.toLowerCase());
  if (ci.length === 1) return ci[0];

  const partial = available.filter(m => m.toLowerCase().includes(requested.toLowerCase()));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `ADetailer model "${requested}" is ambiguous — it matches:\n` +
        partial.map(m => `• ${m}`).join("\n") +
        `\n\nUse the full name from list-adetailer-models.`
    );
  }

  throw new Error(
    `ADetailer model "${requested}" is not available. Installed detectors:\n` +
      available.map(m => `• ${m}`).join("\n") +
      `\n\n(ADetailer-Neo silently skips a unit with an unknown model, so this is ` +
      `rejected up front rather than producing a quietly un-detailed image.)`
  );
}

// ---------------------------------------------------------------------------
// ADetailer unit schema
// ---------------------------------------------------------------------------
//
// Field names below map 1:1 onto ADetailer-Neo's ADetailerArgs. Because that
// model forbids extra keys, nothing outside this set may be emitted.

export const adetailerUnitSchema = z.object({
  model: z
    .string()
    .default("face_yolov8n.pt")
    .describe("Detector from list-adetailer-models, e.g. face_yolov8n.pt, hand_yolov8n.pt, person_yolov8n-seg.pt, or a MediaPipe model"),
  model_classes: z
    .string()
    .optional()
    .describe("Comma-separated class filter for detectors that report classes (YOLO-World etc.); empty means all"),
  prompt: z.string().optional().describe("Prompt for the inpaint pass (empty = reuse the main prompt)"),
  negative_prompt: z.string().optional().describe("Negative prompt for the inpaint pass"),

  // Detection
  confidence: z.number().optional().describe("Detection confidence threshold, 0.0-1.0 (Neo default: 0.3)"),
  mask_filter_method: z
    .enum(["Area", "Confidence"])
    .optional()
    .describe("How detections are ranked when limiting with mask_k (Neo default: Area)"),
  mask_k: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Keep only the top-k detections; 0 = keep all (Neo default: 0)"),
  mask_min_ratio: z.number().optional().describe("Discard masks smaller than this fraction of the image, 0.0-1.0"),
  mask_max_ratio: z.number().optional().describe("Discard masks larger than this fraction of the image, 0.0-1.0"),

  // Mask shaping
  dilate_erode: z.number().int().optional().describe("Dilate (positive) or erode (negative) the mask, in pixels (Neo default: 4)"),
  x_offset: z.number().int().optional().describe("Shift the mask horizontally, in pixels"),
  y_offset: z.number().int().optional().describe("Shift the mask vertically, in pixels"),
  mask_merge_invert: z
    .enum(["None", "Merge", "Merge and Invert"])
    .optional()
    .describe("Merge all detections into one mask, and optionally invert it (Neo default: None)"),
  mask_blur: z.number().int().nonnegative().optional().describe("Mask blur in pixels (Neo default: 4)"),

  // Inpainting
  denoising_strength: z.number().optional().describe("Inpaint denoising strength, 0.0-1.0 (Neo default: 0.4)"),
  inpaint_only_masked: z.boolean().optional().describe("Inpaint at full resolution inside the mask only (Neo default: true)"),
  inpaint_only_masked_padding: z.number().int().nonnegative().optional().describe("Padding around the mask in pixels (Neo default: 32)"),
  inpaint_width: z.number().int().positive().optional().describe("Inpaint pass width; setting this enables use_inpaint_width_height"),
  inpaint_height: z.number().int().positive().optional().describe("Inpaint pass height; setting this enables use_inpaint_width_height"),

  // Per-pass overrides — each one flips its matching ad_use_* flag automatically
  steps: z.number().int().optional().describe("Override sampling steps for this pass (1-150)"),
  cfg_scale: z.number().optional().describe("Override CFG scale for this pass (1.0-24.0)"),
  checkpoint: z.string().optional().describe("Override the checkpoint for this pass"),
  vae: z.string().optional().describe("Override the VAE for this pass"),
  sampler: z.string().optional().describe("Override the sampler for this pass"),
  scheduler: z.string().optional().describe("Override the scheduler for this pass"),
  noise_multiplier: z.number().optional().describe("Override the noise multiplier for this pass (0.5-1.5)"),

  restore_face: z.boolean().optional().describe("Run face restoration after this pass"),
  enabled: z.boolean().optional().describe("Set false to define a unit but skip it (maps to ad_tab_enable)"),
});

export type AdetailerUnit = z.infer<typeof adetailerUnitSchema>;

export const adetailerSchema = z
  .array(adetailerUnitSchema)
  .optional()
  .describe(
    "ADetailer passes to run after generation, one per detector (e.g. faces, then hands). " +
    "Requires the ADetailer-Neo extension — see list-adetailer-models."
  );

/**
 * Translate one unit into Neo's ad_* keys. Undefined inputs are omitted so the
 * extension supplies its own defaults, and each optional override sets both its
 * value and the ad_use_* flag that gates it.
 */
function adetailerUnitToArgs(unit: AdetailerUnit, resolvedModel: string): Record<string, unknown> {
  const args: Record<string, unknown> = { ad_model: resolvedModel };

  const set = (key: string, value: unknown) => {
    if (value !== undefined) args[key] = value;
  };

  set("ad_model_classes", unit.model_classes);
  set("ad_prompt", unit.prompt);
  set("ad_negative_prompt", unit.negative_prompt);
  set("ad_confidence", unit.confidence);
  set("ad_mask_filter_method", unit.mask_filter_method);
  set("ad_mask_k", unit.mask_k);
  set("ad_mask_min_ratio", unit.mask_min_ratio);
  set("ad_mask_max_ratio", unit.mask_max_ratio);
  set("ad_dilate_erode", unit.dilate_erode);
  set("ad_x_offset", unit.x_offset);
  set("ad_y_offset", unit.y_offset);
  set("ad_mask_merge_invert", unit.mask_merge_invert);
  set("ad_mask_blur", unit.mask_blur);
  set("ad_denoising_strength", unit.denoising_strength);
  set("ad_inpaint_only_masked", unit.inpaint_only_masked);
  set("ad_inpaint_only_masked_padding", unit.inpaint_only_masked_padding);
  set("ad_restore_face", unit.restore_face);
  set("ad_tab_enable", unit.enabled);

  // Paired value + gate flags.
  if (unit.inpaint_width !== undefined || unit.inpaint_height !== undefined) {
    args.ad_use_inpaint_width_height = true;
    set("ad_inpaint_width", unit.inpaint_width);
    set("ad_inpaint_height", unit.inpaint_height);
  }
  if (unit.steps !== undefined) {
    args.ad_use_steps = true;
    args.ad_steps = unit.steps;
  }
  if (unit.cfg_scale !== undefined) {
    args.ad_use_cfg_scale = true;
    args.ad_cfg_scale = unit.cfg_scale;
  }
  if (unit.checkpoint !== undefined) {
    args.ad_use_checkpoint = true;
    args.ad_checkpoint = unit.checkpoint;
  }
  if (unit.vae !== undefined) {
    args.ad_use_vae = true;
    args.ad_vae = unit.vae;
  }
  if (unit.sampler !== undefined || unit.scheduler !== undefined) {
    args.ad_use_sampler = true;
    set("ad_sampler", unit.sampler);
    set("ad_scheduler", unit.scheduler);
  }
  if (unit.noise_multiplier !== undefined) {
    args.ad_use_noise_multiplier = true;
    args.ad_noise_multiplier = unit.noise_multiplier;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Escape hatch
// ---------------------------------------------------------------------------

export const extraAlwaysonSchema = z
  .record(z.any())
  .optional()
  .describe(
    "Advanced: raw alwayson_scripts entries merged into the request, for any other extension " +
    "(ControlNet, regional prompting, and so on). Shape: { \"<Script Name>\": { \"args\": [...] } }. " +
    "Use list-extensions with script_details to find the script name and its argument order."
  );

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AlwaysonInput {
  adetailer?: AdetailerUnit[];
  extra?: Record<string, unknown>;
  /** img2img only: skip the img2img pass ADetailer would otherwise run. */
  skipImg2img?: boolean;
}

/**
 * Build the alwayson_scripts object for a generation request, or undefined when
 * nothing was requested (so the payload stays exactly as it was before).
 * Throws when a detector name cannot be resolved.
 */
export async function buildAlwaysonScripts(
  input: AlwaysonInput
): Promise<Record<string, { args: unknown[] }> | undefined> {
  const scripts: Record<string, { args: unknown[] }> = {};

  if (input.adetailer && input.adetailer.length > 0) {
    const available = await fetchAdetailerModels();
    const units = input.adetailer.map(unit =>
      adetailerUnitToArgs(unit, resolveAdetailerModel(unit.model, available))
    );
    scripts[ADETAILER_SCRIPT_NAME] = {
      args: [true, input.skipImg2img ?? false, ...units],
    };
  }

  if (input.extra) {
    for (const [key, value] of Object.entries(input.extra)) {
      scripts[key] = value as { args: unknown[] };
    }
  }

  return Object.keys(scripts).length > 0 ? scripts : undefined;
}

/** One-line summary of what was attached, for the tool's text response. */
export function describeAlwayson(scripts: Record<string, { args: unknown[] }> | undefined): string {
  if (!scripts) return "";
  const parts = Object.entries(scripts).map(([name, value]) => {
    if (name === ADETAILER_SCRIPT_NAME && Array.isArray(value.args)) {
      const models = value.args
        .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
        .map(a => String(a.ad_model));
      return `${name} (${models.join(", ")})`;
    }
    const count = Array.isArray(value.args) ? value.args.length : 0;
    return `${name} (${count} args)`;
  });
  return `\nExtensions applied: ${parts.join(", ")}`;
}
