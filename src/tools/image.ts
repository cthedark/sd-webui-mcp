// src/tools/image.ts

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StableDiffusionAPI } from '../api/sd-api.js';
import {
  SD_API_URL,
  USE_DEFAULT_NEGATIVE_PROMPT,
  DEFAULT_NEGATIVE_PROMPTS,
  GENERATION_WAIT_SECONDS,
  GENERATION_TIMEOUT_MS,
} from '../config.js';
import {
  saveBase64Image,
  validateImagePath,
  readImageAsBase64,
  createErrorResponse,
} from '../utils/image-io.js';
import { runAsJob, deliverJob, ProgressContext } from './job-response.js';
import { getJob, listJobs, pickDefaultJob, runningJobs, waitForJob, describeElapsed } from '../jobs.js';
import { resolveModuleSelection, USE_SAME_MODULES } from './modules.js';
import {
  buildLoraTags,
  loadLorasForResolution,
  loraArraySchema,
  LoraResolutionError,
} from './loras.js';
import {
  adetailerSchema,
  extraAlwaysonSchema,
  buildAlwaysonScripts,
  describeAlwayson,
} from './alwayson.js';

const api = new StableDiffusionAPI(SD_API_URL);

// Build the final negative prompt by merging defaults (when enabled) with
// any user-supplied terms, then deduplicating.
function buildNegativePrompt(userPrompt: string | undefined): string {
  const userTerms = (userPrompt || "")
    .split(",")
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);

  if (!USE_DEFAULT_NEGATIVE_PROMPT) {
    return userTerms.join(", ");
  }

  const defaultTerms = DEFAULT_NEGATIVE_PROMPTS.map(t => t.trim().toLowerCase());
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const term of [...defaultTerms, ...userTerms]) {
    if (!seen.has(term)) {
      seen.add(term);
      merged.push(term);
    }
  }

  return merged.join(", ");
}

/**
 * Append resolved <lora:name:weight> tags to a prompt. Tags the caller already
 * wrote by hand are left alone — this only adds what came in via `loras`.
 */
async function applyLoras(
  prompt: string,
  loras: Array<{ name: string; weight?: number; te_weight?: number }> | undefined
): Promise<{ prompt: string; tags: string }> {
  if (!loras || loras.length === 0) {
    return { prompt, tags: "" };
  }
  const available = await loadLorasForResolution();
  const tags = buildLoraTags(loras, available);
  return { prompt: tags ? `${prompt} ${tags}` : prompt, tags };
}

// Define schema for image generation tool
const generateImageSchema = {
  prompt: z.string().describe("Text prompt describing the image to generate"),
  negative_prompt: z.string().optional().describe("Negative prompt specifying what should NOT be in the image"),
  loras: loraArraySchema,
  width: z.number().default(1024).describe("Image width (default: 1024)"),
  height: z.number().default(1024).describe("Image height (default: 1024)"),
  cfg_scale: z.number().default(7).describe("CFG scale (default: 7)"),
  steps: z.number().default(30).describe("Sampling steps (default: 30)"),
  sampler_index: z.string().default("Euler a").describe("Sampler to use (default: Euler a)"),
  scheduler: z.string().optional().describe("Scheduler / noise schedule, e.g. Simple, Karras, Exponential"),
  seed: z.number().default(-1).describe("Random seed (-1 for random)"),
  enable_hr: z.boolean().default(false).describe("Enable hi-res fix for higher quality upscaled output (default: false)"),
  hr_scale: z.number().default(1.5).describe("Hi-res fix upscale factor (default: 1.5)"),
  hr_upscaler: z.string().default("Latent").describe("Hi-res fix upscaler method; see list-upscalers (default: Latent)"),
  hr_denoising_strength: z.number().default(0.6).describe("Hi-res fix denoising strength (0.0-1.0, default: 0.6)"),
  hr_second_pass_steps: z.number().default(10).describe("Hi-res fix second pass sampling steps (default: 10)"),
  hr_modules: z
    .array(z.string())
    .optional()
    .describe(
      "VAE / Text Encoder modules for the hi-res pass. Omit to reuse the first pass's modules " +
      "(the default, and almost always what you want); pass an empty array to fall back to the " +
      "checkpoint's built-in modules; or name modules from list-vae-modules to switch for the second pass."
    ),
  adetailer: adetailerSchema,
  extra_alwayson_scripts: extraAlwaysonSchema,
  wait_seconds: z
    .number()
    .optional()
    .describe(
      `How long to wait for the image before returning a job id instead (default: ${GENERATION_WAIT_SECONDS}s). ` +
      `The generation continues either way; collect it with check-generation.`
    ),
};

// Define schema for image editing tool
const editImageSchema = {
  image_path: z.string().describe("Path to input image to edit"),
  prompt: z.string().describe("Text prompt describing the desired changes"),
  negative_prompt: z.string().optional().describe("Negative prompt specifying what should NOT be in the image"),
  loras: loraArraySchema,
  denoising_strength: z.number().default(0.75).describe("How much to change the image (0.0-1.0, default: 0.75)"),
  cfg_scale: z.number().default(7).describe("CFG scale (default: 7)"),
  steps: z.number().default(30).describe("Sampling steps (default: 30)"),
  sampler_index: z.string().default("Euler a").describe("Sampler to use (default: Euler a)"),
  scheduler: z.string().optional().describe("Scheduler / noise schedule, e.g. Simple, Karras, Exponential"),
  seed: z.number().default(-1).describe("Random seed (-1 for random)"),
  adetailer: adetailerSchema,
  extra_alwayson_scripts: extraAlwaysonSchema,
  wait_seconds: z
    .number()
    .optional()
    .describe(
      `How long to wait for the image before returning a job id instead (default: ${GENERATION_WAIT_SECONDS}s). ` +
      `The edit continues either way; collect it with check-generation.`
    ),
};

export function registerImageTools(server: McpServer): void {
  server.registerTool(
    "generate-image",
    {
      description:
        "Generate an image using Stable Diffusion from a text prompt. Supports LoRAs (see list-loras), " +
        "hi-res fix, and ADetailer detailing passes (see list-adetailer-models).",
      inputSchema: generateImageSchema,
    },
    async ({ prompt, negative_prompt, loras, width, height, cfg_scale, steps, sampler_index, scheduler, seed, enable_hr, hr_scale, hr_upscaler, hr_denoising_strength, hr_second_pass_steps, hr_modules, adetailer, extra_alwayson_scripts, wait_seconds }, extra) => {
      try {
        const isConnected = await api.checkStatus();
        if (!isConnected) {
          return createErrorResponse("Cannot connect to Stable Diffusion API. Please ensure WebUI is running.");
        }

        // Resolve LoRA tags and extension arguments before starting anything,
        // so a bad name fails immediately instead of after a full render.
        let finalPrompt: string;
        let loraTags: string;
        try {
          const applied = await applyLoras(prompt, loras);
          finalPrompt = applied.prompt;
          loraTags = applied.tags;
        } catch (error) {
          if (error instanceof LoraResolutionError) {
            return createErrorResponse(error.message);
          }
          throw error;
        }

        let alwaysonScripts;
        try {
          alwaysonScripts = await buildAlwaysonScripts({
            adetailer,
            extra: extra_alwayson_scripts,
          });
        } catch (error) {
          return createErrorResponse(
            `Could not prepare extension arguments: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        console.error(`Image generation request: "${finalPrompt}" (${width}x${height}, hi-res: ${enable_hr})`);

        const finalNegativePrompt = buildNegativePrompt(negative_prompt);
        console.error(`Using negative prompt: "${finalNegativePrompt}"`);

        const payload: Record<string, unknown> = {
          prompt: finalPrompt,
          negative_prompt: finalNegativePrompt,
          width,
          height,
          cfg_scale,
          steps,
          sampler_name: sampler_index,
          seed,
          enable_hr,
        };

        if (scheduler) payload.scheduler = scheduler;

        // Only send hi-res parameters when hi-res fix is on. denoising_strength
        // has a meaning in txt2img only for the second pass, so sending it
        // unconditionally was misleading.
        if (enable_hr) {
          payload.hr_scale = hr_scale;
          payload.hr_upscaler = hr_upscaler;
          payload.denoising_strength = hr_denoising_strength;
          payload.hr_second_pass_steps = hr_second_pass_steps;

          // hr_additional_modules MUST be a list whenever hi-res fix is on.
          // Forge Neo declares it as `hr_additional_modules: list = field(default=None)`
          // and then iterates it without a None check, so leaving it out of the
          // payload crashes the WebUI in modules_change() with
          // "'NoneType' object is not iterable" rather than returning an error.
          // The "Use same choices" sentinel makes processing.py skip
          // modules_change entirely, so the second pass inherits the loaded
          // VAE / Text Encoder without triggering a model reload.
          try {
            payload.hr_additional_modules = await resolveModuleSelection(
              hr_modules ?? [USE_SAME_MODULES]
            );
          } catch (error) {
            return createErrorResponse(
              `Could not resolve hr_modules: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        if (alwaysonScripts) payload.alwayson_scripts = alwaysonScripts;

        return await runAsJob({
          kind: "txt2img",
          label: prompt,
          headline: `Image successfully generated: "${prompt}"`,
          details:
            (loraTags ? `\nLoRAs: ${loraTags}` : "") + describeAlwayson(alwaysonScripts),
          waitSeconds: wait_seconds ?? GENERATION_WAIT_SECONDS,
          context: extra as ProgressContext,
          work: async () => {
            const base64Image = await api.textToImage(payload, GENERATION_TIMEOUT_MS);
            return await saveBase64Image(base64Image);
          },
        });
      } catch (error) {
        console.error("Image generation error:", error);
        return createErrorResponse(`Error occurred during image generation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.registerTool(
    "edit-image",
    {
      description:
        "Edit an existing image using Stable Diffusion img2img. Supports LoRAs and ADetailer detailing " +
        "passes. For a pure resolution increase with no other changes, use upscale-image instead.",
      inputSchema: editImageSchema,
    },
    async ({ image_path, prompt, negative_prompt, loras, denoising_strength, cfg_scale, steps, sampler_index, scheduler, seed, adetailer, extra_alwayson_scripts, wait_seconds }, extra) => {
      try {
        if (!await validateImagePath(image_path)) {
          return createErrorResponse(
            `Invalid image path: ${image_path}. Please specify a path to a valid image file.`
          );
        }

        const isConnected = await api.checkStatus();
        if (!isConnected) {
          return createErrorResponse("Cannot connect to Stable Diffusion API. Please ensure WebUI is running.");
        }

        let finalPrompt: string;
        let loraTags: string;
        try {
          const applied = await applyLoras(prompt, loras);
          finalPrompt = applied.prompt;
          loraTags = applied.tags;
        } catch (error) {
          if (error instanceof LoraResolutionError) {
            return createErrorResponse(error.message);
          }
          throw error;
        }

        let alwaysonScripts;
        try {
          alwaysonScripts = await buildAlwaysonScripts({
            adetailer,
            extra: extra_alwayson_scripts,
          });
        } catch (error) {
          return createErrorResponse(
            `Could not prepare extension arguments: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        console.error(`Image edit request: "${finalPrompt}" (input: ${image_path})`);

        const base64Image = await readImageAsBase64(image_path);
        const finalNegativePrompt = buildNegativePrompt(negative_prompt);
        console.error(`Using negative prompt: "${finalNegativePrompt}"`);

        const payload: Record<string, unknown> = {
          init_images: [base64Image],
          prompt: finalPrompt,
          negative_prompt: finalNegativePrompt,
          denoising_strength,
          cfg_scale,
          steps,
          sampler_name: sampler_index,
          seed,
        };

        if (scheduler) payload.scheduler = scheduler;
        if (alwaysonScripts) payload.alwayson_scripts = alwaysonScripts;

        return await runAsJob({
          kind: "img2img",
          label: prompt,
          headline: `Image successfully edited: "${prompt}"`,
          details:
            (loraTags ? `\nLoRAs: ${loraTags}` : "") +
            describeAlwayson(alwaysonScripts) +
            `\nOriginal image: ${image_path}`,
          waitSeconds: wait_seconds ?? GENERATION_WAIT_SECONDS,
          context: extra as ProgressContext,
          work: async () => {
            const resultBase64 = await api.imageToImage(payload, GENERATION_TIMEOUT_MS);
            return await saveBase64Image(resultBase64);
          },
        });
      } catch (error) {
        console.error("Image editing error:", error);
        return createErrorResponse(`Error occurred during image editing: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Collecting results that outlived the client's request deadline
  // -------------------------------------------------------------------------

  server.registerTool(
    "check-generation",
    {
      description:
        "Collect the result of a generation that was still running when generate-image, edit-image or " +
        "upscale-image returned a job id. With no arguments it picks up the job you are most likely " +
        "waiting on. Waits for the image if it is nearly ready, and reports live progress otherwise.",
      inputSchema: {
        job_id: z
          .string()
          .optional()
          .describe("Job id to collect; omit to pick up the most relevant pending job"),
        wait_seconds: z
          .number()
          .optional()
          .describe(
            `How long to wait for the job to finish before reporting progress (default: ${GENERATION_WAIT_SECONDS}s)`
          ),
      },
    },
    async ({ job_id, wait_seconds }) => {
      const job = job_id ? getJob(job_id) : pickDefaultJob();

      if (!job) {
        const all = listJobs();
        return createErrorResponse(
          job_id
            ? `No job with id "${job_id}". ` +
              (all.length
                ? `Known jobs:\n\n` + all.map(j => `\u2022 ${j.id} — ${j.status} — "${j.label}"`).join("\n")
                : `No generations have been started in this session.`)
            : `No generations have been started in this session.`
        );
      }

      if (job.status === "running") {
        await waitForJob(job, Math.max(1, wait_seconds ?? GENERATION_WAIT_SECONDS) * 1000);
      }

      if (job.status === "done") {
        return await deliverJob(job, `Job ${job.id} finished: "${job.label}"`);
      }

      if (job.status === "error") {
        job.delivered = true;
        return createErrorResponse(
          `Job ${job.id} failed after ${describeElapsed(job)}.\n\n${job.error}`
        );
      }

      let progressLine = "";
      try {
        const progress = await api.getProgress();
        const percent = Math.round((progress.progress ?? 0) * 100);
        const eta = Math.round(progress.eta_relative ?? 0);
        progressLine =
          `\nProgress: ${percent}%` +
          (progress.state?.sampling_steps
            ? ` (step ${progress.state.sampling_step}/${progress.state.sampling_steps})`
            : "") +
          (eta > 0 ? `, roughly ${eta}s remaining` : "");
      } catch {
        /* progress is optional */
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Job ${job.id} is still running after ${describeElapsed(job)}: "${job.label}"${progressLine}\n\n` +
              `Call check-generation again to keep waiting, or cancel-generation to stop it.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "list-generations",
    {
      description: "List generations started in this session and whether their results have been collected",
    },
    async () => {
      const all = listJobs();
      if (all.length === 0) {
        return { content: [{ type: "text" as const, text: "No generations have been started in this session." }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${all.length} generation(s), newest first:\n\n` +
              all
                .map(j => {
                  const state =
                    j.status === "running"
                      ? `running (${describeElapsed(j)} so far)`
                      : j.status === "done"
                      ? `done in ${describeElapsed(j)}${j.delivered ? "" : " — not yet collected"}`
                      : `failed after ${describeElapsed(j)}`;
                  return `\u2022 ${j.id} — ${state}\n  "${j.label}"` + (j.imagePath ? `\n  ${j.imagePath}` : "");
                })
                .join("\n\n"),
          },
        ],
      };
    }
  );

  server.registerTool(
    "cancel-generation",
    {
      description:
        "Interrupt the generation the WebUI is currently working on. This stops whatever is rendering " +
        "now, which is the running job unless something was queued behind it.",
    },
    async () => {
      const running = runningJobs();

      try {
        await api.interrupt();
      } catch (error) {
        return createErrorResponse(
          `Could not interrupt the WebUI.\n\n${error instanceof Error ? error.message : String(error)}`
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Sent an interrupt to the WebUI.` +
              (running.length
                ? `\n\nJobs that were running:\n` +
                  running.map(j => `\u2022 ${j.id} — "${j.label}"`).join("\n") +
                  `\n\nAn interrupted generation usually returns a partial image rather than an error.`
                : `\n\nNo jobs were tracked as running, so this only affects work started elsewhere.`),
          },
        ],
      };
    }
  );
}
