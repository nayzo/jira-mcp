#!/usr/bin/env node
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JiraClient } from "./jira/api.js";
import { registerTools } from "./jira/tools.js";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const server = new McpServer({ name: "jira-mcp", version: "1.0.0" });
registerTools(server, new JiraClient());
server.connect(new StdioServerTransport()).catch(() => {
  console.error("[JIRA-MCP] Could not start the stdio server");
  process.exitCode = 1;
});
