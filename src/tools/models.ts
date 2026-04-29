import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StableDiffusionAPI } from "../api/sd-api.js";
import { SD_API_URL } from "../config.js";

// Create API client
const api = new StableDiffusionAPI(SD_API_URL);

// Register model management tools
export function registerModelTools(server: McpServer) {
  // List available models
  server.registerTool(
    "list-models",
    {
      description: "List all available Stable Diffusion models",
    },
    async () => {
      const models = await api.getModels();
      
      if (models.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No models found or unable to connect to Stable Diffusion WebUI. Please ensure it is running with the API enabled."
            }
          ]
        };
      }
      
      return {
        content: [
          {
            type: "text",
            text: "Available Stable Diffusion models:\n\n" + models.map(model => `• ${model}`).join("\n")
          }
        ]
      };
    }
  );
  
  // Change active model
  server.registerTool(
    "change-model",
    {
      description: "Change the active Stable Diffusion model",
      inputSchema: {
        model_name: z.string().describe("Name of the model to switch to")
      },
    },
    async ({ model_name }: { model_name: string }) => {
      // Get available models first to validate
      const models = await api.getModels();
      
      // Check if the model exists
      if (!models.some(model => model === model_name)) {
        return {
          content: [
            {
              type: "text",
              text: `Model "${model_name}" not found. Available models are:\n\n` +
                models.map(model => `• ${model}`).join("\n")
            }
          ]
        };
      }
      
      // Attempt to change the model
      const success = await api.changeModel(model_name);
      
      if (success) {
        return {
          content: [
            {
              type: "text",
              text: `Successfully switched to model: ${model_name}`
            }
          ]
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Failed to switch to model: ${model_name}. Please ensure Stable Diffusion WebUI is running with the API enabled.`
            }
          ]
        };
      }
    }
  );
  
  // List samplers
  server.registerTool(
    "list-samplers",
    {
      description: "List all available samplers in Stable Diffusion",
    },
    async () => {
      const samplers = await api.getSamplers();
      
      if (samplers.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No samplers found or unable to connect to Stable Diffusion WebUI. Please ensure it is running with the API enabled."
            }
          ]
        };
      }
      
      return {
        content: [
          {
            type: "text",
            text: "Available samplers:\n\n" + samplers.map(sampler => `• ${sampler}`).join("\n")
          }
        ]
      };
    }
  );
}
