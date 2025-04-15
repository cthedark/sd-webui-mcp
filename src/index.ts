#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./server.js";
import { SD_API_URL, OUTPUT_DIR } from "./config.js";

// Entry point for the MCP server
async function main() {
  try {
    console.error("Starting Stable Diffusion MCP Server...");
    console.error(`API URL: ${SD_API_URL}`);
    console.error(`Output Directory: ${OUTPUT_DIR}`);
    
    // Create transport for communication with the MCP client
    const transport = new StdioServerTransport();
    
    // Connect the server to the transport
    await server.connect(transport);
    
    console.error("Stable Diffusion MCP Server running and listening on stdio");
    console.error("Waiting for requests...");
  } catch (error) {
    console.error("Error starting MCP server:", error);
    process.exit(1);
  }
}

// Start the server
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});