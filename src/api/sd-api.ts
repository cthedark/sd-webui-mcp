// src/api/sd-api.ts

import fetch, { Response } from 'node-fetch';

// インターフェース定義の追加
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

  // タイムアウト付きのfetchヘルパーメソッド
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

  // リトライヘルパーメソッド
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
          console.error(`試行 ${attempt + 1} が失敗しました。${delayMs}ms後に再試行します...`);
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
        console.error('API状態確認中にリクエストタイムアウトが発生しました');
      } else {
        console.error('API状態確認中にエラーが発生しました:', error);
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
      console.error("モデル一覧の取得中にエラーが発生しました:", error);
      return [];
    }
  }

  async getSamplers(): Promise<string[]> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/sdapi/v1/samplers`);
      const samplers = await response.json() as SDSamplerInfo[];
      return samplers.map(sampler => sampler.name);
    } catch (error) {
      console.error("サンプラー一覧の取得中にエラーが発生しました:", error);
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
      console.error(`モデル ${modelName} への変更中にエラーが発生しました:`, error);
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
        }, 60000); // 画像生成は60秒のタイムアウトを設定
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`テキストから画像APIの呼び出しに失敗しました: ${response.status} ${response.statusText} - ${errorText}`);
        }
        
        const data = await response.json() as SDTextToImageResponse;
        if (!data.images || data.images.length === 0) {
          throw new Error("テキストから画像APIがイメージを返しませんでした");
        }
        
        return data.images[0];
      });
    } catch (error) {
      console.error("リトライ後もテキストから画像APIの呼び出しに失敗しました:", error);
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
        }, 60000); // 画像生成は60秒のタイムアウトを設定
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`画像から画像APIの呼び出しに失敗しました: ${response.status} ${response.statusText} - ${errorText}`);
        }
        
        const data = await response.json() as SDImageToImageResponse;
        if (!data.images || data.images.length === 0) {
          throw new Error("画像から画像APIがイメージを返しませんでした");
        }
        
        return data.images[0];
      });
    } catch (error) {
      console.error("リトライ後も画像から画像APIの呼び出しに失敗しました:", error);
      return null;
    }
  }
}