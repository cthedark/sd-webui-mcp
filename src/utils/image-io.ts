// src/utils/image-io.ts
//
// Shared image plumbing: saving base64 results to OUTPUT_DIR, validating input
// paths, and turning a saved file into an MCP image content block.

import path from "path";
import fs from "fs-extra";
import sharp from "sharp";
import { OUTPUT_DIR, SEND_FULL_IMAGE_BASE64 } from "../config.js";

/** Strip a possible `data:image/png;base64,` prefix. */
export function stripDataUrlPrefix(base64Image: string): string {
  return base64Image.includes(",") ? base64Image.split(",")[1] : base64Image;
}

/** Save a base64 image to OUTPUT_DIR and return the full path. */
export async function saveBase64Image(base64Image: string, prefix = "sd_image"): Promise<string> {
  try {
    const buffer = Buffer.from(stripDataUrlPrefix(base64Image), "base64");

    // Timestamp is filename-safe on Windows (no colons).
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${prefix}_${timestamp}.png`;
    const filePath = path.join(OUTPUT_DIR, fileName);

    await fs.writeFile(filePath, buffer);
    return filePath;
  } catch (error) {
    console.error(`Image save error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** True when the path exists and sharp can read it as an image. */
export async function validateImagePath(imagePath: string): Promise<boolean> {
  if (!(await fs.pathExists(imagePath))) {
    return false;
  }
  try {
    await sharp(imagePath).metadata();
    return true;
  } catch {
    return false;
  }
}

/** Read a file from disk as raw base64 (for sending into the SD API). */
export async function readImageAsBase64(imagePath: string): Promise<string> {
  const buffer = await fs.readFile(imagePath);
  return buffer.toString("base64");
}

/**
 * Convert an image on disk into a payload for the MCP response.
 * SEND_FULL_IMAGE_BASE64=true -> full resolution JPEG (q80).
 * SEND_FULL_IMAGE_BASE64=false -> 512px PNG thumbnail.
 */
export async function imageToResponseBase64(imagePath: string): Promise<{ data: string; mimeType: string }> {
  try {
    if (!(await fs.pathExists(imagePath))) {
      throw new Error(`File not found: ${imagePath}`);
    }

    const metadata = await sharp(imagePath).metadata();
    const isLarge = (metadata.width || 0) * (metadata.height || 0) > 5000000;

    const pipeline = sharp(imagePath, {
      limitInputPixels: 100000000,
      sequentialRead: isLarge,
    });

    if (SEND_FULL_IMAGE_BASE64) {
      const buffer = await pipeline.jpeg({ quality: 80 }).toBuffer();
      return { data: buffer.toString("base64"), mimeType: "image/jpeg" };
    }

    const buffer = await pipeline
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return { data: buffer.toString("base64"), mimeType: "image/png" };
  } catch (error) {
    console.error(`Image conversion error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** Width/height of an image on disk, for reporting upscale results. */
export async function imageDimensions(imagePath: string): Promise<{ width: number; height: number }> {
  const metadata = await sharp(imagePath).metadata();
  return { width: metadata.width ?? 0, height: metadata.height ?? 0 };
}

export function createErrorResponse(message: string): any {
  return { content: [{ type: "text", text: message }] };
}

export function createImageResponse(messageText: string, imageData: string, mimeType = "image/png"): any {
  return {
    content: [
      { type: "text", text: messageText },
      { type: "image", data: imageData, mimeType },
    ],
  };
}
