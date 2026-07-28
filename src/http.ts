#!/usr/bin/env node

/**
 * HTTP entrypoint for remote MCP hosting (Railway, Langdock, etc.).
 *
 * The upstream project ships a STDIO transport (src/index.ts) which only works
 * for local clients like Claude Desktop. This file exposes the exact same tool
 * set over Streamable HTTP so a remote MCP client can reach it.
 *
 * No extra dependencies: uses the Node built-in http module.
 */

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { AdsClient } from "./services/ads-client.js";

// --- Tool imports ---
import { registerCampaignTools } from "./tools/campaigns.js";
import { registerAdsetTools } from "./tools/adsets.js";
import { registerAdTools } from "./tools/ads.js";
import { registerCreativeTools } from "./tools/creatives.js";
import { registerImageTools } from "./tools/images.js";
import { registerVideoTools } from "./tools/videos.js";
import { registerCanvasTools } from "./tools/canvas.js";
import { registerAudienceTools } from "./tools/audiences.js";
import { registerTargetingTools } from "./tools/targeting.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerLeadTools } from "./tools/leads.js";
import { registerCatalogTools } from "./tools/catalogs.js";
import { registerFeedTools } from "./tools/feeds.js";
import { registerRuleTools } from "./tools/rules.js";
import { registerExperimentTools } from "./tools/experiments.js";
import { registerConversionTools } from "./tools/conversions.js";
import { registerBudgetTools } from "./tools/budget.js";
import { registerReachFrequencyTools } from "./tools/reach_frequency.js";
import { registerBrandSafetyTools } from "./tools/brand_safety.js";
import { registerAccountTools } from "./tools/account.js";
import { registerBusinessTools } from "./tools/business.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerAdLibraryTools } from "./tools/ad_library.js";

// --- Resources & Prompts ---
import { registerResources } from "./resources/account.js";
import { registerPrompts } from "./prompts/index.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const PORT = Number(process.env.PORT) || 8000;
const MCP_PATH = process.env.MCP_PATH || "/mcp";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

/** Build a fully wired MCP server instance. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "meta-ads-mcp", version });
  const client = new AdsClient(loadConfig());

  registerCampaignTools(server, client);
  registerAdsetTools(server, client);
  registerAdTools(server, client);
  registerCreativeTools(server, client);
  registerImageTools(server, client);
  registerVideoTools(server, client);
  registerCanvasTools(server, client);
  registerAudienceTools(server, client);
  registerTargetingTools(server, client);
  registerInsightTools(server, client);
  registerLeadTools(server, client);
  registerCatalogTools(server, client);
  registerFeedTools(server, client);
  registerRuleTools(server, client);
  registerExperimentTools(server, client);
  registerConversionTools(server, client);
  registerBudgetTools(server, client);
  registerReachFrequencyTools(server, client);
  registerBrandSafetyTools(server, client);
  registerAccountTools(server, client);
  registerBusinessTools(server, client);
  registerAuthTools(server, client);
  registerAdLibraryTools(server, client);
  registerResources(server, client);
  registerPrompts(server);

  return server;
}

/** Read and parse a JSON request body. */
function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Optional shared-secret check so the endpoint is not fully public. */
function isAuthorized(req: import("node:http").IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization || "";
  return header === `Bearer ${AUTH_TOKEN}`;
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Health check for Railway
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "meta-ads-mcp", version }));
    return;
  }

  if (url.pathname !== MCP_PATH) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // Stateless mode: a fresh server + transport per request keeps horizontal
  // scaling on Railway simple and avoids cross-tenant session leaks.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        })
      );
    }
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.error(`meta-ads-mcp listening on 0.0.0.0:${PORT}${MCP_PATH}`);
});
