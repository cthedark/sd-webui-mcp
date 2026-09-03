// src/tools/image.ts

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StableDiffusionAPI } from '../api/sd-api.js';
import {
  SD_API_URL,
  USE_DEFAULT_NEGATIVE_PROMPT,
  DEFAULT_NEGATIVE_PROMPTS,
} from '../config.js';
import {
  saveBase64Image,
  validateImagePath,
  readImageAsBase64,
  imageToResponseBase64,
  createErrorResponse,
  createImageResponse,
} from '../utils/image-io.js';
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
  adetailer: adetailerSchema,
  extra_alwayson_scripts: extraAlwaysonSchema,
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
    async ({ prompt, negative_prompt, loras, width, height, cfg_scale, steps, sampler_index, scheduler, seed, enable_hr, hr_scale, hr_upscaler, hr_denoising_strength, hr_second_pass_steps, adetailer, extra_alwayson_scripts }) => {
      try {
        // Check if API is connected
        const isConnected = await api.checkStatus();
        if (!isConnected) {
          return createErrorResponse("Cannot connect to Stable Diffusion API. Please ensure WebUI is running.");
        }

        // Resolve and append LoRA tags before anything else, so a bad LoRA name
        // fails fast instead of after a full generation.
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
        }

        if (alwaysonScripts) payload.alwayson_scripts = alwaysonScripts;

        const base64Image = await api.textToImage(payload);

        if (!base64Image) {
          return createErrorResponse("Failed to generate image. No response from Stable Diffusion API.");
        }

        try {
          const imagePath = await saveBase64Image(base64Image);
          console.error(`Image saved: ${imagePath}`);

          const responseImage = await imageToResponseBase64(imagePath);

          return createImageResponse(
            `Image successfully generated: "${prompt}"` +
              (loraTags ? `\nLoRAs: ${loraTags}` : "") +
              describeAlwayson(alwaysonScripts) +
              `\n\nImage path: ${imagePath}`,
            responseImage.data,
            responseImage.mimeType
          );
        } catch (saveError) {
          console.error("Image save error:", saveError);
          return createErrorResponse(`Image generation succeeded, but an error occurred during saving: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
        }
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
    async ({ image_path, prompt, negative_prompt, loras, denoising_strength, cfg_scale, steps, sampler_index, scheduler, seed, adetailer, extra_alwayson_scripts }) => {
      try {
        // Validate image path
        if (!await validateImagePath(image_path)) {
          return createErrorResponse(
            `Invalid image path: ${image_path}. Please specify a path to a valid image file.`
          );
        }

        // Check if API is connected
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

        try {
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

          const resultBase64 = await api.imageToImage(payload);

          if (!resultBase64) {
            return createErrorResponse("Failed to edit image. No response from Stable Diffusion API.");
          }

          const editedImagePath = await saveBase64Image(resultBase64);
          console.error(`Edited image saved: ${editedImagePath}`);

          const responseImage = await imageToResponseBase64(editedImagePath);

          return createImageResponse(
            `Image successfully edited: "${prompt}"` +
              (loraTags ? `\nLoRAs: ${loraTags}` : "") +
              describeAlwayson(alwaysonScripts) +
              `\n\nOriginal image: ${image_path}\nEdited image: ${editedImagePath}`,
            responseImage.data,
            responseImage.mimeType
          );
        } catch (processError) {
          console.error("Image processing error:", processError);
          return createErrorResponse(`Error occurred while reading or processing the image: ${processError instanceof Error ? processError.message : String(processError)}`);
        }
      } catch (error) {
        console.error("Image editing error:", error);
        return createErrorResponse(`Error occurred during image editing: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
