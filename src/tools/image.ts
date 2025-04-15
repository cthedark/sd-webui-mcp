// src/tools/image.ts

import path from 'path';
import fs from 'fs-extra';
import sharp from 'sharp';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StableDiffusionAPI } from '../api/sd-api.js';
import { SD_API_URL, OUTPUT_DIR } from '../config.js';

const api = new StableDiffusionAPI(SD_API_URL);

// エラーレスポンスを作成するヘルパー
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

// 画像付き成功レスポンスを作成するヘルパー
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

// Base64画像を保存する
async function saveBase64Image(base64Image: string): Promise<string> {
  try {
    // Base64文字列からデータ部分のみを抽出
    const data = base64Image.split(',')[1] || base64Image;
    const buffer = Buffer.from(data, 'base64');
    
    // 出力ファイル名を生成（日時を使用）
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const fileName = `sd_image_${timestamp}.png`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    
    // 画像を保存
    await fs.writeFile(filePath, buffer);
    
    return filePath;
  } catch (error) {
    console.error(`画像保存エラー: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// 画像パスの検証
async function validateImagePath(imagePath: string): Promise<boolean> {
  if (!await fs.pathExists(imagePath)) {
    return false;
  }
  
  try {
    // ファイルが有効な画像かどうかをメタデータを読み取って確認
    await sharp(imagePath).metadata();
    return true;
  } catch (error) {
    return false;
  }
}

// サムネイル作成とBase64変換
async function createThumbnailAsBase64(imagePath: string): Promise<string> {
  try {
    // ファイルの存在確認
    const exists = await fs.pathExists(imagePath);
    if (!exists) {
      throw new Error(`ファイルが見つかりません: ${imagePath}`);
    }
    
    // まず画像メタデータを取得
    const metadata = await sharp(imagePath).metadata();
    const isLarge = (metadata.width || 0) * (metadata.height || 0) > 5000000; // 5MPしきい値
    
    // 大きい画像にはよりメモリ効率の良いアプローチを使用
    let pipeline = sharp(imagePath, { 
      limitInputPixels: 100000000, // より大きな画像を許可するがDOSを防止
      sequentialRead: isLarge // 大きな画像には順次読み取りを使用
    });
    
    // サムネイルを作成
    const thumbnailBuffer = await pipeline
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 }) // 最大圧縮
      .toBuffer();
    
    // バッファをbase64文字列に変換
    const thumbnailBase64 = thumbnailBuffer.toString('base64');
    
    return thumbnailBase64;
  } catch (error) {
    console.error(`サムネイル作成エラー: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// 画像生成ツールのスキーマ定義
const generateImageSchema = {
  prompt: z.string().describe("生成する画像を説明するテキストプロンプト"),
  negative_prompt: z.string().optional().describe("画像に含めるべきではないものを指定する否定的なプロンプト"),
  width: z.number().default(1024).describe("画像の幅（デフォルト: 1024）"),
  height: z.number().default(1024).describe("画像の高さ（デフォルト: 1024）"),
  cfg_scale: z.number().default(7).describe("CFGスケール（デフォルト: 7）"),
  steps: z.number().default(30).describe("サンプリングステップ数（デフォルト: 30）"),
  sampler_index: z.string().default("Euler a").describe("使用するサンプラー（デフォルト: Euler a）"),
  seed: z.number().default(-1).describe("ランダムシード（-1でランダム）")
};

// 画像編集ツールのスキーマ定義
const editImageSchema = {
  image_path: z.string().describe("編集する入力画像へのパス"),
  prompt: z.string().describe("希望する変更を説明するテキストプロンプト"),
  negative_prompt: z.string().optional().describe("画像に含めるべきではないものを指定する否定的なプロンプト"),
  denoising_strength: z.number().default(0.75).describe("画像をどれだけ変更するか（0.0-1.0、デフォルト: 0.75）"),
  cfg_scale: z.number().default(7).describe("CFGスケール（デフォルト: 7）"),
  steps: z.number().default(30).describe("サンプリングステップ数（デフォルト: 30）"),
  sampler_index: z.string().default("Euler a").describe("使用するサンプラー（デフォルト: Euler a）"),
  seed: z.number().default(-1).describe("ランダムシード（-1でランダム）"),
};

export function registerImageTools(server: McpServer): void {
  server.tool(
    "generate-image",
    "テキストプロンプトからStable Diffusionを使用して画像を生成",
    generateImageSchema,
    async ({ prompt, negative_prompt, width, height, cfg_scale, steps, sampler_index, seed }) => {
      try {
        // APIが接続されているか確認
        const isConnected = await api.checkStatus();
        if (!isConnected) {
          return createErrorResponse("Stable Diffusion APIに接続できません。WebUIが実行中であることを確認してください。");
        }

        console.error(`画像生成リクエスト: "${prompt}" (${width}x${height})`);
        
        // Stable Diffusionに画像生成リクエスト
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
          return createErrorResponse("画像生成に失敗しました。Stable Diffusion APIからの応答がありません。");
        }

        try {
          // 画像をファイルとして保存
          const imagePath = await saveBase64Image(base64Image);
          console.error(`画像を保存しました: ${imagePath}`);
          
          // サムネイルを作成（メモリ効率が良いバージョン）
          const thumbnailBase64 = await createThumbnailAsBase64(imagePath);
          
          // 成功レスポンスを返す
          return createImageResponse(
            `画像が正常に生成されました: "${prompt}"\n\n画像パス: ${imagePath}`,
            thumbnailBase64
          );
        } catch (saveError) {
          console.error("画像保存エラー:", saveError);
          return createErrorResponse(`画像生成は成功しましたが、保存中にエラーが発生しました: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
        }
      } catch (error) {
        console.error("画像生成エラー:", error);
        return createErrorResponse(`画像生成中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "edit-image",
    "Stable Diffusionを使用して既存の画像を編集",
    editImageSchema,
    async ({ image_path, prompt, negative_prompt, denoising_strength, cfg_scale, steps, sampler_index, seed }) => {
      try {
        // 画像パスを検証
        if (!await validateImagePath(image_path)) {
          return createErrorResponse(
            `無効な画像パス: ${image_path}。有効な画像ファイルへのパスを指定してください。`
          );
        }
        
        // APIが接続されているか確認
        const isConnected = await api.checkStatus();
        if (!isConnected) {
          return createErrorResponse("Stable Diffusion APIに接続できません。WebUIが実行中であることを確認してください。");
        }

        console.error(`画像編集リクエスト: "${prompt}" (入力: ${image_path})`);
        
        try {
          // 入力画像を読み込んでbase64に変換
          const imageBuffer = await fs.readFile(image_path);
          const base64Image = imageBuffer.toString('base64');
          
          // 画像編集を実行
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
            return createErrorResponse("画像編集に失敗しました。Stable Diffusion APIからの応答がありません。");
          }
          
          // 編集された画像を保存
          const editedImagePath = await saveBase64Image(resultBase64);
          console.error(`編集された画像を保存しました: ${editedImagePath}`);
          
          // サムネイルを作成
          const thumbnailBase64 = await createThumbnailAsBase64(editedImagePath);
          
          // 成功レスポンスを返す
          return createImageResponse(
            `画像が正常に編集されました: "${prompt}"\n\n元の画像: ${image_path}\n編集済み画像: ${editedImagePath}`,
            thumbnailBase64
          );
        } catch (processError) {
          console.error("画像処理エラー:", processError);
          return createErrorResponse(`画像の読み込みまたは処理中にエラーが発生しました: ${processError instanceof Error ? processError.message : String(processError)}`);
        }
      } catch (error) {
        console.error("画像編集エラー:", error);
        return createErrorResponse(`画像編集中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}