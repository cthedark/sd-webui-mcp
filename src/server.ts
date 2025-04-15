import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs-extra";
import { OUTPUT_DIR } from "./config.js";
import { registerImageTools } from "./tools/image.js";
import { registerModelTools } from "./tools/models.js";
import { registerUtilityTools } from "./tools/utils.js";

// Ensure the output directory exists
fs.ensureDirSync(OUTPUT_DIR);

// Create the MCP server instance
export const server = new McpServer({
  name: "StableDiffusionLocal",
  version: "1.0.0",
  description: "MCP Server for local Stable Diffusion WebUI",
  capabilities: {
    resources: {},
    tools: {} // Tools will be registered later
  }
});

// Register all tools
registerImageTools(server);
registerModelTools(server);
registerUtilityTools(server);

// Log server capabilities
console.error("Stable Diffusion MCP Server initialized with the following tools:");
console.error(" - generate-image: Generate an image from text prompt");
console.error(" - edit-image: Edit an existing image using text prompt");
console.error(" - list-models: List available Stable Diffusion models");
console.error(" - change-model: Change the active Stable Diffusion model");
console.error(" - list-samplers: List available samplers");
console.error(" - check-status: Check connection to Stable Diffusion WebUI");