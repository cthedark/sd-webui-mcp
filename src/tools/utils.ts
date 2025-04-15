import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StableDiffusionAPI } from "../api/sd-api.js";
import { SD_API_URL } from "../config.js";

// Create API client
const api = new StableDiffusionAPI(SD_API_URL);

// Register utility tools
export function registerUtilityTools(server: McpServer) {
  // Check connection status
  server.tool(
    "check-status",
    "Check connection to Stable Diffusion WebUI",
    {},
    async () => {
      const isConnected = await api.checkStatus();
      
      if (isConnected) {
        return {
          content: [
            {
              type: "text",
              text: `✅ Successfully connected to Stable Diffusion WebUI at ${SD_API_URL}`
            }
          ]
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to connect to Stable Diffusion WebUI at ${SD_API_URL}\n\n` +
                "Please ensure that:\n" +
                "1. Stable Diffusion WebUI is running\n" +
                "2. It was started with the --api flag\n" +
                "3. The API URL is correct (currently set to " + SD_API_URL + ")"
            }
          ]
        };
      }
    }
  );
}