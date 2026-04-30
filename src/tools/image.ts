// src/tools/image.ts

import path from 'path';
import fs from 'fs-extra';
import sharp from 'sharp';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StableDiffusionAPI } from '../api/sd-api.js';
import { SD_API_URL, OUTPUT_DIR, USE_DEFAULT_NEGATIVE_PROMPT, DEFAULT_NEGATIVE_PROMPTS, SEND_FULL_IMAGE_BASE64 } from '../config.js';

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

// Helper function to create error response
function createErrorResponse(message: string): any {
  return {
    content: [
      {
        type: "text",
        text: message
      }
    ]
  };
}

// Helper function to create image success response
function createImageResponse(
  messageText: string,
  imageData: string,
  mimeType = "image/png"
): any {
  return {
    content: [
      {
        type: "text",
        text: messageText
      },
      {
        type: "image",
        data: imageData,
        mimeType
      }
    ]
  };
}

// Save Base64 image to file
async function saveBase64Image(base64Image: string): Promise<string> {
  try {
    // Extract only data portion from the Base64 string
    const data = base64Image.split(',')[1] || base64Image;
    const buffer = Buffer.from(data, 'base64');
    
    // Generate output filename (using timestamp)
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\.+/, '');
    const fileName = `sd_image_${timestamp}.png`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    
    // Save the image
    await fs.writeFile(filePath, buffer);
    
    return filePath;
  } catch (error) {
    console.error(`Image save error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Validate image path
async function validateImagePath(imagePath: string): Promise<boolean> {
  if (!await fs.pathExists(imagePath)) {
    return false;
  }
  
  try {
    // Attempt to read metadata to validate it's a valid image
    await sharp(imagePath).metadata();
    return true;
  } catch (error) {
    return false;
  }
}

// Convert an image to base64 for the MCP response.
// When SEND_FULL_IMAGE_BASE64 is true, sends the full resolution as a compressed JPEG.
// Otherwise, sends a 512px thumbnail PNG.
async function imageToResponseBase64(imagePath: string): Promise<{ data: string; mimeType: string }> {
  try {
    const exists = await fs.pathExists(imagePath);
    if (!exists) {
      throw new Error(`File not found: ${imagePath}`);
    }

    const metadata = await sharp(imagePath).metadata();
    const isLarge = (metadata.width || 0) * (metadata.height || 0) > 5000000;

    let pipeline = sharp(imagePath, {
      limitInputPixels: 100000000,
      sequentialRead: isLarge
    });

    let buffer: Buffer;
    let mimeType: string;

    if (SEND_FULL_IMAGE_BASE64) {
      // Full resolution, compressed JPEG
      buffer = await pipeline
        .jpeg({ quality: 80 })
        .toBuffer();
      mimeType = "image/jpeg";
    } else {
      // 512px thumbnail PNG
      buffer = await pipeline
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
      mimeType = "image/png";
    }

    return { data: buffer.toString('base64'), mimeType };
  } catch (error) {
    console.error(`Image conversion error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Define schema for image generation tool
const generateImageSchema = {
  prompt: z.string().describe("Text prompt describing the image to generate"),
  negative_prompt: z.string().optional().describe("Negative prompt specifying what should NOT be in the image"),
  width: z.number().default(1024).describe("Image width (default: 1024)"),
  height: z.number().default(1024).describe("Image height (default: 1024)"),
  cfg_scale: z.number().default(7).describe("CFG scale (default: 7)"),
  steps: z.number().default(30).describe("Sampling steps (default: 30)"),
  sampler_index: z.string().default("Euler a").describe("Sampler to use (default: Euler a)"),
  seed: z.number().default(-1).describe("Random seed (-1 for random)"),
  enable_hr: z.boolean().default(false).describe("Enable hi-res fix for higher quality upscaled output (default: false)"),
  hr_scale: z.number().default(1.5).describe("Hi-res fix upscale factor (default: 1.5)"),
  hr_upscaler: z.string().default("Latent").describe("Hi-res fix upscaler method (default: Latent)"),
  hr_denoising_strength: z.number().default(0.6).describe("Hi-res fix denoising strength (0.0-1.0, default: 0.6)"),
  hr_second_pass_steps: z.number().default(10).describe("Hi-res fix second pass sampling steps (default: 10)"),
};

// Define schema for image editing tool
const editImageSchema = {
  image_path: z.string().describe("Path to input image to edit"),
  prompt: z.string().describe("Text prompt describing the desired changes"),
  negative_prompt: z.string().optional().describe("Negative prompt specifying what should NOT be in the image"),
  denoising_strength: z.number().default(0.75).describe("How much to change the image (0.0-1.0, default: 0.75)"),
  cfg_scale: z.number().default(7).describe("CFG scale (default: 7)"),
  steps: z.number().default(30).describe("Sampling steps (default: 30)"),
  sampler_index: z.string().default("Euler a").describe("Sampler to use (default: Euler a)"),
  seed: z.number().default(-1).describe("Random seed (-1 for random)"),
};

export function registerImageTools(server: McpServer): void {
  server.registerTool(
    "generate-image",
    {
      description: "Generate an image using Stable Diffusion from a text prompt",
      inputSchema: generateImageSchema,
    },
    async ({ prompt, negative_prompt, width, height, cfg_scale, steps, sampler_index, seed, enable_hr, hr_scale, hr_upscaler, hr_denoising_strength, hr_second_pass_steps }) => {
      try {
        // Check if API is connected
        const isConnected = await api.checkStatus();
        if (!isConnected) {
          return createErrorResponse("Cannot connect to Stable Diffusion API. Please ensure WebUI is running.");
        }

        console.error(`Image generation request: "${prompt}" (${width}x${height}, hi-res: ${enable_hr})`);
        
        // Request image generation from Stable Diffusion
        const finalNegativePrompt = buildNegativePrompt(negative_prompt);
        console.error(`Using negative prompt: "${finalNegativePrompt}"`);

        const base64Image = await api.textToImage({
          prompt,
          negative_prompt: finalNegativePrompt,
          width,
          height,
          cfg_scale,
          steps,
          sampler_name: sampler_index,
          seed,
          enable_hr,
          hr_scale,
          hr_upscaler,
          denoising_strength: hr_denoising_strength,
          hr_second_pass_steps,
        });

        if (!base64Image) {
          return createErrorResponse("Failed to generate image. No response from Stable Diffusion API.");
        }

        try {
          // Save image to file
          const imagePath = await saveBase64Image(base64Image);
          console.error(`Image saved: ${imagePath}`);
          
          // Create response image (full-res or thumbnail based on config)
          const responseImage = await imageToResponseBase64(imagePath);
          
          // Return success response
          return createImageResponse(
            `Image successfully generated: "${prompt}"\n\nImage path: ${imagePath}`,
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
      description: "Edit an existing image using Stable Diffusion",
      inputSchema: editImageSchema,
    },
    async ({ image_path, prompt, negative_prompt, denoising_strength, cfg_scale, steps, sampler_index, seed }) => {
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

        console.error(`Image edit request: "${prompt}" (input: ${image_path})`);
        
        try {
          // Read input image and convert to base64
          const imageBuffer = await fs.readFile(image_path);
          const base64Image = imageBuffer.toString('base64');
          
          // Perform image editing
          const finalNegativePrompt = buildNegativePrompt(negative_prompt);
          console.error(`Using negative prompt: "${finalNegativePrompt}"`);

          const resultBase64 = await api.imageToImage({
            init_images: [base64Image],
            prompt,
            negative_prompt: finalNegativePrompt,
            denoising_strength,
            cfg_scale,
            steps,
            sampler_name: sampler_index,
            seed
          });

          if (!resultBase64) {
            return createErrorResponse("Failed to edit image. No response from Stable Diffusion API.");
          }
          
          // Save edited image
          const editedImagePath = await saveBase64Image(resultBase64);
          console.error(`Edited image saved: ${editedImagePath}`);
          
          // Create response image (full-res or thumbnail based on config)
          const responseImage = await imageToResponseBase64(editedImagePath);
          
          // Return success response
          return createImageResponse(
            `Image successfully edited: "${prompt}"\n\nOriginal image: ${image_path}\nEdited image: ${editedImagePath}`,
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
