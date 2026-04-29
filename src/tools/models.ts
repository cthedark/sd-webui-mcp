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
      
      // Try exact match first
      let matchedModel = models.find(model => model === model_name);
      
      // If no exact match, try fuzzy matching by extracting the filename
      // (strip directory separators and file extension) and checking if any
      // available model contains it as a case-insensitive substring.
      // This handles Windows backslash paths and partial names gracefully.
      if (!matchedModel) {
        // Strip path separators (both / and \) and remove common model file extensions
        const basename = model_name
          .replace(/^.*[/\\]/, "")       // drop everything before the last slash or backslash
          .replace(/\.\w+$/, "");         // drop file extension like .safetensors, .ckpt, etc.
        const lowerBasename = basename.toLowerCase();

        const fuzzyMatches = models.filter(
          model => model.toLowerCase().includes(lowerBasename)
        );

        if (fuzzyMatches.length === 1) {
          matchedModel = fuzzyMatches[0];
        } else if (fuzzyMatches.length > 1) {
          return {
            content: [
              {
                type: "text",
                text: `Multiple models match "${model_name}":\n\n` +
                  fuzzyMatches.map(model => `• ${model}`).join("\n") +
                  `\n\nPlease provide a more specific name.`
              }
            ]
          };
        }
      }

      if (!matchedModel) {
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
      const success = await api.changeModel(matchedModel);
      
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
