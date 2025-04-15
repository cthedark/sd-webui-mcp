# SD WebUI MCP Server

An MCP (Model Context Protocol) server that connects Claude Desktop to your local Stable Diffusion WebUI installation, enabling AI-assisted image generation directly from your conversations.

## 🔋 Overview

This project allows you to utilize your local Stable Diffusion installation through Claude Desktop, giving you the ability to:

* Generate images from text descriptions
* Edit existing images with text prompts
* List and switch between different Stable Diffusion models
* Access advanced image generation parameters
* View image thumbnails directly in Claude responses

All while staying within the Claude Desktop interface, without switching between applications.

## 🎯 Features

* **Text-to-Image Generation**: Create images from text prompts
* **Image-to-Image Editing**: Modify existing images using text guidance
* **Model Management**: List and switch between your installed models
* **Sampler Control**: Access all WebUI samplers
* **Connection Status**: Verify connectivity with your local Stable Diffusion
* **High Performance**: Uses your local GPU resources for image generation
* **Privacy-Focused**: All processing happens on your machine
* **Base64 Thumbnails**: See images directly in Claude responses
* **SDXL Optimized**: Default settings tuned for SDXL's 1024x1024 resolution

## 📦 Prerequisites

* Node.js v16.0.0 or higher
* Stable Diffusion WebUI with API enabled
* Claude Desktop
* Basic familiarity with command line interfaces

## 🚀 Installation

### 1. Clone this repository

```bash
git clone https://github.com/boxi-rgb/sd-webui-mcp.git
cd sd-webui-mcp
```

### 2. Install dependencies

```bash
npm install
```

### 3. Build the project

```bash
npm run build
```

### 4. Configure Stable Diffusion WebUI

Make sure your Stable Diffusion WebUI is running with the API enabled.

#### For Windows:

Edit your `webui-user.bat` file and add `--api` to the COMMANDLINE_ARGS:

```
@echo off
set COMMANDLINE_ARGS=--api
call webui.bat
```

#### For Linux/macOS:

Edit your `webui-user.sh` file and add `--api` to the COMMANDLINE_ARGS:

```bash
export COMMANDLINE_ARGS="--api"
./webui.sh
```

### 5. Configure Claude Desktop

1. Open Claude Desktop
2. Go to Settings
   * Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   * macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
3. Add the following to the `claude_desktop_config.json` file (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "stable-diffusion": {
      "command": "node",
      "args": [
        "/FULL/PATH/TO/sd-webui-mcp/dist/index.js"
      ]
    }
  }
}
```

**Important**: Replace `/FULL/PATH/TO/` with the actual full path to your project directory. For Windows users, use double backslashes (`\\`) or forward slashes (`/`) in your path.

4. Save the file and restart Claude Desktop

## ⚙️ Usage

### Step 1: Verify installation

After starting Claude Desktop, you should see a tools icon (🔧) in the bottom right corner of the chat interface. Click on it to see if "stable-diffusion" appears in the list of available tools.

### Step 2: Check connection

Type the following message to Claude:

```
Can you check if Stable Diffusion is connected properly?
```

Claude should use the `check-status` tool to verify the connection with your local Stable Diffusion WebUI.

### Step 3: Generate your first image

Type something like:

```
Please create an image of a futuristic city with flying cars.
```

Claude will use the `generate-image` tool to send your request to Stable Diffusion and display the resulting image.

### Advanced Usage

The MCP server provides several tools that Claude can use:

#### 1. Image Generation

```
Generate an image of a cat wearing a space suit on Mars.
```

You can add more detailed parameters:

```
Generate an image of a mountain landscape with the following parameters:
- Width: 1024
- Height: 1024
- Steps: 30
- CFG Scale: 8
- Negative prompt: blurry, low quality
```

#### 2. Model Switching

First, check available models:

```
What Stable Diffusion models are available on my system?
```

Then switch models:

```
Please switch to the AnythingV5 model.
```

#### 3. Editing Existing Images

Save an image to your system, then:

```
Edit the image at C:/path/to/image.png to add flowers in the background.
```

#### 4. List Sampling Methods

```
What samplers are available in my Stable Diffusion setup?
```

## 🔧 Configuration

You can customize the behavior of the MCP server by modifying `src/config.ts`:

* `SD_API_URL`: The URL of your Stable Diffusion WebUI API (default: http://127.0.0.1:7861)
* `OUTPUT_DIR`: Directory where generated images will be saved (default: ./output)
* `DEFAULT_PARAMS`: Default image generation parameters optimized for SDXL (1024x1024 resolution)

After modifying, rebuild the project with `npm run build`.

## 🔍 Troubleshooting

### Common Issues

#### MCP server not found in Claude Desktop

* Verify the path in `claude_desktop_config.json` is correct
* Ensure you've included the full absolute path to the `dist/index.js` file
* Check if the Node.js path is correct

#### Cannot connect to Stable Diffusion WebUI

* Make sure Stable Diffusion WebUI is running
* Verify that it was started with the `--api` flag
* Check if the default port (7861) is being used or if you need to specify a custom port in `config.ts`

#### Images not being generated

* Check the output directory exists and has write permissions
* Look for error messages in the Claude Desktop console
* Try running the `check-status` tool to verify connectivity

### Debugging

If you're experiencing issues, you can enable more verbose logging by:

1. Running the MCP server directly from the command line to see error messages:

```bash
node dist/index.js
```

2. You can also use the MCP Inspector for debugging:

```bash
npx @modelcontextprotocol/inspector node /path/to/sd-webui-mcp/dist/index.js
```

## 📝 License

MIT License

## ⚠️ Disclaimer

This project is not officially affiliated with Anthropic (creators of Claude) or Stable Diffusion. Use at your own risk.