// src/api/sd-api.ts

import fetch, { Response } from 'node-fetch';

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

interface SDModelInfo {
  title: string;
  model_name?: string;
  filename?: string;
  [key: string]: unknown;
}

interface SDSamplerInfo {
  name: string;
  [key: string]: unknown;
}

interface SDTextToImageResponse {
  images: string[];
  parameters: Record<string, unknown>;
  info: string;
}

interface SDImageToImageResponse {
  images: string[];
  parameters: Record<string, unknown>;
  info: string;
}

/** GET /sdapi/v1/loras (registered by the built-in Lora extension). */
export interface SDLoraInfo {
  name: string;
  alias: string;
  path: string;
  metadata: Record<string, unknown>;
}

/**
 * GET /sdapi/v1/sd-modules — Forge only.
 * These are the entries behind the "VAE / Text Encoder" multiselect in the UI.
 * `filename` is the absolute path, which is what `forge_additional_modules` wants.
 */
export interface SDModuleInfo {
  model_name: string;
  filename: string;
}

/** GET /sdapi/v1/upscalers */
export interface SDUpscalerInfo {
  name: string;
  model_name: string | null;
  model_path: string | null;
  model_url: string | null;
  scale: number | null;
}

/** GET /sdapi/v1/extensions */
export interface SDExtensionInfo {
  name: string;
  remote: string;
  branch: string;
  commit_hash: string;
  version: string;
  commit_date: string;
  enabled: boolean;
}

/** GET /sdapi/v1/scripts */
export interface SDScriptsList {
  txt2img: string[];
  img2img: string[];
}

/** One entry of GET /sdapi/v1/script-info */
export interface SDScriptInfo {
  name: string;
  is_alwayson: boolean;
  is_img2img: boolean;
  args: Array<{
    label?: string;
    value?: unknown;
    minimum?: unknown;
    maximum?: unknown;
    step?: unknown;
    choices?: unknown[];
  }>;
}

/** POST /sdapi/v1/extra-single-image */
export interface SDExtrasResponse {
  html_info: string;
  image: string;
}

/** Parameters accepted by the extras (upscaling) endpoint. */
export interface SDExtrasParams {
  image: string;
  resize_mode?: 0 | 1;
  upscaling_resize?: number;
  upscaling_resize_w?: number;
  upscaling_resize_h?: number;
  upscaling_crop?: boolean;
  upscaler_1?: string;
  upscaler_2?: string;
  extras_upscaler_2_visibility?: number;
  gfpgan_visibility?: number;
  codeformer_visibility?: number;
  codeformer_weight?: number;
  upscale_first?: boolean;
  show_extras_results?: boolean;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class StableDiffusionAPI {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  // Fetch helper method with timeout
  private async fetchWithTimeout(url: string, options: any = {}, timeoutMs = 30000): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Retry helper method
  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
    delayMs = 1000
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries - 1) {
          console.error(`Attempt ${attempt + 1} failed. Retrying in ${delayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    throw lastError;
  }

  /**
   * GET a JSON endpoint. Unlike the older helpers this THROWS on failure so the
   * calling tool can surface the real reason (404 => endpoint not supported by
   * this WebUI build, connection refused => WebUI not running, etc.) instead of
   * reporting a misleading empty list.
   */
  private async getJson<T>(endpoint: string, timeoutMs = 30000): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.baseUrl}${endpoint}`, {}, timeoutMs);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request to ${endpoint} timed out after ${timeoutMs}ms.`);
      }
      throw new Error(`Could not reach ${this.baseUrl}${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (response.status === 404) {
      throw new Error(
        `${endpoint} returned 404. This WebUI build does not expose that endpoint ` +
        `(it may be provided by an extension that is disabled or not installed).`
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${endpoint} failed: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 500)}` : ""}`);
    }

    return await response.json() as T;
  }

  /** POST a JSON body and parse the JSON response. Throws on failure. */
  private async postJson<T>(endpoint: string, body: unknown, timeoutMs = 60000): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }, timeoutMs);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request to ${endpoint} timed out after ${timeoutMs}ms.`);
      }
      throw new Error(`Could not reach ${this.baseUrl}${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (response.status === 404) {
      throw new Error(
        `${endpoint} returned 404. This WebUI build does not expose that endpoint ` +
        `(it may be provided by an extension that is disabled or not installed).`
      );
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`${endpoint} failed: ${response.status} ${response.statusText}${errText ? ` - ${errText.slice(0, 500)}` : ""}`);
    }

    const text = await response.text();
    if (!text) {
      return undefined as unknown as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined as unknown as T;
    }
  }

  // -------------------------------------------------------------------------
  // Status / models / samplers (pre-existing behaviour preserved)
  // -------------------------------------------------------------------------

  async checkStatus(): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/sdapi/v1/options`);
      return response.ok;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.error('Request timeout occurred during API connection check');
      } else {
        console.error('Error occurred during API connection check:', error);
      }
      return false;
    }
  }

  async getModels(): Promise<string[]> {
    try {
      const models = await this.getJson<SDModelInfo[]>("/sdapi/v1/sd-models");
      return models.map(model => model.title);
    } catch (error) {
      console.error("Error occurred while retrieving model list:", error);
      return [];
    }
  }

  async getSamplers(): Promise<string[]> {
    try {
      const samplers = await this.getJson<SDSamplerInfo[]>("/sdapi/v1/samplers");
      return samplers.map(sampler => sampler.name);
    } catch (error) {
      console.error("Error occurred while retrieving sampler list:", error);
      return [];
    }
  }

  async changeModel(modelName: string): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/sdapi/v1/options`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sd_model_checkpoint: modelName
        })
      }, 180000); // switching checkpoints can take a while
      return response.ok;
    } catch (error) {
      console.error(`Error occurred while changing to model ${modelName}:`, error);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Options (global, persistent server state)
  // -------------------------------------------------------------------------

  /** GET /sdapi/v1/options — the full shared.opts dictionary. */
  async getOptions(): Promise<Record<string, unknown>> {
    return await this.getJson<Record<string, unknown>>("/sdapi/v1/options");
  }

  /**
   * POST /sdapi/v1/options — merges the given keys into shared.opts.
   * This is PERSISTENT: it mutates the running WebUI's global settings (the
   * same state the host's own UI uses) and is written to config.json, so it
   * survives subsequent API calls and a restart. Contrast with a payload's
   * `override_settings`, which is reverted after the request by default.
   */
  async setOptions(options: Record<string, unknown>, timeoutMs = 300000): Promise<void> {
    await this.postJson<void>("/sdapi/v1/options", options, timeoutMs);
  }

  // -------------------------------------------------------------------------
  // LoRAs
  // -------------------------------------------------------------------------

  /** GET /sdapi/v1/loras — provided by the built-in Lora extension. */
  async getLoras(): Promise<SDLoraInfo[]> {
    return await this.getJson<SDLoraInfo[]>("/sdapi/v1/loras");
  }

  /** POST /sdapi/v1/refresh-loras — rescan the LoRA directory. */
  async refreshLoras(): Promise<void> {
    await this.postJson<void>("/sdapi/v1/refresh-loras", {}, 60000);
  }

  // -------------------------------------------------------------------------
  // Forge VAE / Text Encoder modules
  // -------------------------------------------------------------------------

  /**
   * GET /sdapi/v1/sd-modules — Forge only. The VAE / Text Encoder files Forge
   * has discovered. `filename` is the absolute path expected by
   * `forge_additional_modules`.
   */
  async getModules(): Promise<SDModuleInfo[]> {
    return await this.getJson<SDModuleInfo[]>("/sdapi/v1/sd-modules");
  }

  /** Currently selected VAE / Text Encoder module paths (Forge). */
  async getActiveModules(): Promise<string[]> {
    const options = await this.getOptions();
    const active = options["forge_additional_modules"];
    return Array.isArray(active) ? active.map(String) : [];
  }

  /** Set the active VAE / Text Encoder module paths (Forge). Persistent. */
  async setActiveModules(paths: string[]): Promise<void> {
    await this.setOptions({ forge_additional_modules: paths });
  }

  // -------------------------------------------------------------------------
  // Extensions / scripts
  // -------------------------------------------------------------------------

  async getExtensions(): Promise<SDExtensionInfo[]> {
    return await this.getJson<SDExtensionInfo[]>("/sdapi/v1/extensions");
  }

  async getScripts(): Promise<SDScriptsList> {
    return await this.getJson<SDScriptsList>("/sdapi/v1/scripts");
  }

  async getScriptInfo(): Promise<SDScriptInfo[]> {
    return await this.getJson<SDScriptInfo[]>("/sdapi/v1/script-info");
  }

  // -------------------------------------------------------------------------
  // Upscalers / extras
  // -------------------------------------------------------------------------

  async getUpscalers(): Promise<SDUpscalerInfo[]> {
    return await this.getJson<SDUpscalerInfo[]>("/sdapi/v1/upscalers");
  }

  async getLatentUpscaleModes(): Promise<Array<{ name: string }>> {
    return await this.getJson<Array<{ name: string }>>("/sdapi/v1/latent-upscale-modes");
  }

  /**
   * POST /sdapi/v1/extra-single-image — the "Extras" tab: pure upscaling and
   * face restoration, no diffusion. Returns a base64 PNG.
   */
  async extraSingleImage(params: SDExtrasParams, timeoutMs = 600000): Promise<string> {
    const data = await this.postJson<SDExtrasResponse>("/sdapi/v1/extra-single-image", {
      resize_mode: 0,
      show_extras_results: true,
      gfpgan_visibility: 0,
      codeformer_visibility: 0,
      codeformer_weight: 0,
      upscaling_resize: 2,
      upscaling_crop: true,
      upscaler_1: "None",
      upscaler_2: "None",
      extras_upscaler_2_visibility: 0,
      upscale_first: false,
      ...params
    }, timeoutMs);

    if (!data || !data.image) {
      throw new Error("The extras endpoint returned no image.");
    }
    return data.image;
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  async textToImage(params: any, timeoutMs = 600000): Promise<string | null> {
    try {
      return await this.withRetry(async () => {
        const data = await this.postJson<SDTextToImageResponse>("/sdapi/v1/txt2img", params, timeoutMs);
        if (!data || !data.images || data.images.length === 0) {
          throw new Error("Text-to-image API did not return any images");
        }
        return data.images[0];
      });
    } catch (error) {
      console.error("Failed to call text-to-image API even after retries:", error);
      return null;
    }
  }

  async imageToImage(params: any, timeoutMs = 600000): Promise<string | null> {
    try {
      return await this.withRetry(async () => {
        const data = await this.postJson<SDImageToImageResponse>("/sdapi/v1/img2img", params, timeoutMs);
        if (!data || !data.images || data.images.length === 0) {
          throw new Error("Image-to-image API did not return any images");
        }
        return data.images[0];
      });
    } catch (error) {
      console.error("Failed to call image-to-image API even after retries:", error);
      return null;
    }
  }
}
