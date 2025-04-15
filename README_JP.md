# SD WebUI MCP サーバー

このプロジェクトは、Claude DesktopをローカルのStable Diffusion WebUIと接続するためのMCP（Model Context Protocol）サーバーです。これによりClaudeからテキストプロンプトを使って画像生成や編集ができるようになります。

## 概要

- Stable Diffusion WebUIへの簡単な接続
- テキストからの画像生成（Text-to-Image）
- 既存画像の編集（Image-to-Image）
- Stable Diffusionモデルの一覧表示と切り替え
- サンプラーの一覧表示
- 高解像度画像の生成とサムネイル表示

## 前提条件

- [Node.js](https://nodejs.org/) (v16以上)
- [Stable Diffusion WebUI](https://github.com/AUTOMATIC1111/stable-diffusion-webui) （APIアクセスが有効になっていること）
- [Claude Desktop](https://claude.ai/desktop)

## インストール

1. リポジトリをクローンまたはダウンロードします：
   ```
   git clone https://github.com/boxi-rgb/sd-webui-mcp.git
   cd sd-webui-mcp
   ```

2. 必要なパッケージをインストールします：
   ```
   npm install
   ```

3. プロジェクトをビルドします：
   ```
   npm run build
   ```

## 設定

`src/config.ts` ファイルで以下の設定が可能です：

- `SD_API_URL`: Stable Diffusion WebUI APIのURL（デフォルト: `http://127.0.0.1:7861`）
- `OUTPUT_DIR`: 生成された画像の保存先ディレクトリ
- `DEFAULT_PARAMS`: 画像生成のデフォルトパラメータ（サイズ、ステップ数など）

## 使用方法

1. **Stable Diffusion WebUI の起動:** 
   Stable Diffusion WebUIを起動し、APIアクセスが有効 (--api オプション付き) になっていることを確認します。通常、WebUIは http://127.0.0.1:7860 で起動します。

2. **Claude Desktop の設定:**
   * claude_desktop_config.json ファイルを開きます。
      * **Windows:** %APPDATA%\Claude\claude_desktop_config.json
      * **macOS:** ~/Library/Application Support/Claude/claude_desktop_config.json
      * (ファイルが存在しない場合は、新しく作成してください)
   * 以下の内容を追加または更新し、このMCPサーバーの実行ファイル (dist/index.js) への**絶対パス**を指定します。 **/FULL/PATH/TO/ の部分は、あなた環境に合わせて実際の絶対パスに置き換えてください。**

```
{
  "mcpServers": {
    "stable-diffusion": {
      "command": "node",
      "args": [
        "/FULL/PATH/TO/sd-webui-mcp/dist/index.js" 
        // 例 (Windows): "C:\\Users\\YourUser\\path\\to\\sd-webui-mcp\\dist\\index.js"
        // 例 (macOS/Linux): "/Users/youruser/path/to/sd-webui-mcp/dist/index.js"
      ]
    }
    // 他のMCPサーバーの設定があれば、カンマで区切って追けます
  }
}
```

   * **注意:** Windowsのパス区切り文字 \ は、JSON内では \\ と二重にするか、互換性に / を使用してください。
   * ファイルを保存し、**Claude Desktopアプリケーションを必ず再起動**してください。

3. **Claude Desktop での指示:** 
   Claude Desktopを再起動後、ツールリストに stable-diffusion が表示されていれば設定完了です。Claudeに対して以下のように画像生成や編集の指示を出せるようになります。
   * 例: 「猫の画像を生成してください」
   * 例: 「C:\SD_Output\sd_image_....png を編集して背景を青くしてください」 (編集ツールを使う場合は、各画像のフルパスを指定します)

## 利用可能なツール

MCPサーバーは、以下のツールをClaude Desktopに提供します：

### 画像生成・編集
- `generate-image`: テキストプロンプトから画像を生成
- `edit-image`: 既存の画像を編集

### モデル管理
- `list-models`: 利用可能なStable Diffusionモデルを一覧表示
- `change-model`: 使用するモデルを変更
- `list-samplers`: 利用可能なサンプラーを一覧表示
- `check-status`: Stable Diffusion WebUIへの接続状態を確認

## パラメータ説明

### generate-image
- `prompt`: 生成したい画像の説明（必須）
- `negative_prompt`: 画像に含めたくない要素（オプション）
- `width`: 画像の幅（デフォルト: 1024）
- `height`: 画像の高さ（デフォルト: 1024）
- `steps`: サンプリングステップ数（デフォルト: 30）
- `cfg_scale`: CFGスケール（デフォルト: 7）
- `sampler_index`: 使用するサンプラー（デフォルト: "Euler a"）
- `seed`: ランダムシード（-1でランダム）

### edit-image
- `image_path`: 編集する画像のパス（必須）
- `prompt`: 編集内容の説明（必須）
- `negative_prompt`: 画像に含めたくない要素（オプション）
- `denoising_strength`: 元の画像からの変更の強さ（0.0-1.0、デフォルト: 0.75）
- その他のパラメータはgenerate-imageと同じ

## 応答形式

画像生成・編集ツールからの応答は以下の形式になります：
1. テキストメッセージ：プロンプト情報と高解像度画像の保存場所
2. サムネイル画像：最大512x512ピクセルのBase64エンコードされた画像

高解像度画像は指定された出力ディレクトリに保存され、そのパスがテキストメッセージに含まれます。

## トラブルシューティング

1. **「Stable Diffusion WebUIが実行されていることを確認してください」というエラーが表示される場合**
   - Stable Diffusion WebUIが起動しているか確認してください
   - WebUIでAPIが有効になっているか確認してください
   - `src/config.ts`のSD_API_URLが正しいか確認してください

2. **生成された画像が表示されない場合**
   - `OUTPUT_DIR`が存在し、書き込み権限があるか確認してください
   - Claude Desktopとの接続が正常か確認してください
   - Claude Desktopを再起動してみてください

3. **Claude DesktopでMCPサーバーが認識されない場合**
   - claude_desktop_config.jsonの設定を確認してください
   - サーバーの実行ファイルへのパスが正しいか確認してください
   - Claude Desktopを再起動したか確認してください

## ライセンス

MIT