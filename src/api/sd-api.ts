// src/api/sd-api.ts

import fetch, { Response } from 'node-fetch';

// Add interface definitions
interface SDModelInfo {
  title: string;
  name: string;
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

export class StableDiffusionAPI {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
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
      const response = await this.fetchWithTimeout(`${this.baseUrl}/sdapi/v1/sd-models`);
      const models = await response.json() as SDModelInfo[];
      return models.map(model => model.title);
    } catch (error) {
      console.error("Error occurred while retrieving model list:", error);
      return [];
    }
  }

  async getSamplers(): Promise<string[]> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/sdapi/v1/samplers`);
      const samplers = await response.json() as SDSamplerInfo[];
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
      });
      return response.ok;
    } catch (error) {
      console.error(`Error occurred while changing to model ${modelName}:`, error);
      return false;
    }
  }

  async textToImage(params: any): Promise<string | null> {
    try {
      return await this.withRetry(async () => {
        const response = await this.fetchWithTimeout(`${this.baseUrl}/sdapi/v1/txt2img`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(params)
        }, 60000); // Set 60 second timeout for image generation
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to call text-to-image API: ${response.status} ${response.statusText} - ${errorText}`);
        }
        
        const data = await response.json() as SDTextToImageResponse;
        if (!data.images || data.images.length === 0) {
          throw new Error("Text-to-image API did not return any images");
        }
        
        return data.images[0];
      });
    } catch (error) {
      console.error("Failed to call text-to-image API even after retries:", error);
      return null;
    }
  }

  async imageToImage(params: any): Promise<string | null> {
    try {
      return await this.withRetry(async () => {
        const response = await this.fetchWithTimeout(`${this.baseUrl}/sdapi/v1/img2img`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(params)
        }, 60000); // Set 60 second timeout for image generation
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to call image-to-image API: ${response.status} ${response.statusText} - ${errorText}`);
        }
        
        const data = await response.json() as SDImageToImageResponse;
        if (!data.images || data.images.length === 0) {
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