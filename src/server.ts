import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs-extra";
import { OUTPUT_DIR } from "./config.js";
import { registerImageTools } from "./tools/image.js";
import { registerModelTools } from "./tools/models.js";
import { registerLoraTools } from "./tools/loras.js";
import { registerExtrasTools } from "./tools/extras.js";
import { registerModuleTools } from "./tools/modules.js";
import { registerUtilityTools } from "./tools/utils.js";

// Ensure the output directory exists
fs.ensureDirSync(OUTPUT_DIR);

// Create the MCP server instance
export const server = new McpServer({
  name: "StableDiffusionLocal",
  version: "1.1.0",
  description: "MCP Server for local Stable Diffusion WebUI (Forge)",
});

// Register all tools
registerImageTools(server);
registerModelTools(server);
registerLoraTools(server);
registerExtrasTools(server);
registerModuleTools(server);
registerUtilityTools(server);

// Log server capabilities
console.error("Stable Diffusion MCP Server initialized with the following tools:");
console.error("  Generation");
console.error("   - generate-image: Generate an image from a text prompt");
console.error("   - edit-image: Edit an existing image using a text prompt");
console.error("  Models");
console.error("   - list-models: List available Stable Diffusion checkpoints");
console.error("   - change-model: Change the active checkpoint");
console.error("   - list-samplers: List available samplers");
console.error("  LoRAs");
console.error("   - list-loras: List available LoRAs with aliases and trigger words");
console.error("   - refresh-loras: Rescan the LoRA directory");
console.error("  Extensions & upscaling");
console.error("   - list-extensions: List installed extensions and their scripts");
console.error("   - list-adetailer-models: List ADetailer-Neo detector models");
console.error("   - list-upscalers: List available upscalers");
console.error("   - upscale-image: Upscale an image via the Extras tab");
console.error("  VAE / Text Encoder (Forge)");
console.error("   - list-vae-modules: List VAE/Text Encoder modules and which are loaded");
console.error("   - set-vae-modules: Change the loaded VAE/Text Encoder modules");
console.error("   - get-sd-settings: Show current global WebUI settings");
console.error("  Utilities");
console.error("   - check-status: Check connection to Stable Diffusion WebUI");
