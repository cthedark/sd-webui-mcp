// src/tools/image.ts

import path from 'path';
import fs from 'fs-extra';
import sharp from 'sharp';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StableDiffusionAPI } from '../api/sd-api.js';
import { SD_API_URL, OUTPUT_DIR } from '../config.js';

const api = new StableDiffusionAPI(SD_API_URL);

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

// Create thumbnail and convert to Base64
async function createThumbnailAsBase64(imagePath: string): Promise<string> {
  try {
    // Check if file exists
    const exists = await fs.pathExists(imagePath);
    if (!exists) {
      throw new Error(`File not found: ${imagePath}`);
    }
    
    // Get image metadata first
    const metadata = await sharp(imagePath).metadata();
    const isLarge = (metadata.width || 0) * (metadata.height || 0) > 5000000; // 5MP threshold
    
    // Use appropriate options for large images
    let pipeline = sharp(imagePath, { 
      limitInputPixels: 100000000, // Allow larger images but prevent DOS
      sequentialRead: isLarge // Use sequential reading for large images
    });
    
    // Create thumbnail
    const thumbnailBuffer = await pipeline
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 }) // Maximum compression
      .toBuffer();
    
    // Convert buffer to base64 string
    const thumbnailBase64 = thumbnailBuffer.toString('base64');
    
    return thumbnailBase64;
  } catch (error) {
    console.error(`Thumbnail creation error: ${error instanceof Error ? error.message : String(error)}`);
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
  seed: z.number().default(-1).describe("Random seed (-1 for random)")
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
    async ({ prompt, negative_prompt, width, height, cfg_scale, steps, sampler_index, seed }) => {
      try {
        // Check if API is connected
        const isConnected = await api.checkStatus();
        if (!isConnected) {
          return createErrorResponse("Cannot connect to Stable Diffusion API. Please ensure WebUI is running.");
        }

        console.error(`Image generation request: "${prompt}" (${width}x${height})`);
        
        // Request image generation from Stable Diffusion
        const base64Image = await api.textToImage({
          prompt,
          negative_prompt: negative_prompt || "",
          width,
          height,
          cfg_scale,
          steps,
          sampler_name: sampler_index,
          seed,
          enable_hr: false
        });

        if (!base64Image) {
          return createErrorResponse("Failed to generate image. No response from Stable Diffusion API.");
        }

        try {
          // Save image to file
          const imagePath = await saveBase64Image(base64Image);
          console.error(`Image saved: ${imagePath}`);
          
          // Create thumbnail (memory-efficient version)
          const thumbnailBase64 = await createThumbnailAsBase64(imagePath);
          
          // Return success response
          return createImageResponse(
            `Image successfully generated: "${prompt}"\n\nImage path: ${imagePath}`,
            thumbnailBase64
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
          const resultBase64 = await api.imageToImage({
            init_images: [base64Image],
            prompt,
            negative_prompt: negative_prompt || "",
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
          
          // Create thumbnail
          const thumbnailBase64 = await createThumbnailAsBase64(editedImagePath);
          
          // Return success response
          return createImageResponse(
            `Image successfully edited: "${prompt}"\n\nOriginal image: ${image_path}\nEdited image: ${editedImagePath}`,
            thumbnailBase64
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
