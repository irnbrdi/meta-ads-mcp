#!/usr/bin/env node

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { AdsClient } from "./services/ads-client.js";

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
import { registerResources } from "./resources/account.js";
import { registerPrompts } from "./prompts/index.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const PORT = Number(process.env.PORT) || 8000;
const MCP_PATH = process.env.MCP_PATH || "/mcp";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

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

function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
  });
}

function isAuthorized(req: import("node:http").IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization || "";
  return header === "Bearer " + AUTH_TOKEN;
}

// Session store
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport; lastUsed: number }>();

async function getOrCreateSession(sessionId?: string): Promise<{ transport: StreamableHTTPServerTransport; server: McpServer; id: string }> {
  if (sessionId && sessions.has(sessionId)) {
    const s = sessions.get(sessionId)!;
    s.lastUsed = Date.now();
    return { transport: s.transport, server: s.server, id: sessionId };
  }

  const id = randomUUID();
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  sessions.set(id, { server, transport, lastUsed: Date.now() });
  transport.onclose = () => { sessions.delete(id); };
  return { transport, server, id };
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));

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

  if (req.method === "DELETE") {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (sid && sessions.has(sid)) {
      const s = sessions.get(sid)!;
      await s.transport.close();
      await s.server.close();
      sessions.delete(sid);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (req.method === "GET") {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (sid && sessions.has(sid)) {
      await sessions.get(sid)!.transport.handleRequest(req, res);
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No valid session" }));
    }
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const body = await readJsonBody(req);
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const session = await getOrCreateSession(sid);

    res.on("close", () => {
      // Keep session alive for reuse, cleanup handled by interval
    });

    await session.transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  }
});

// Clean up stale sessions every 5 minutes (idle > 30 min)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > 30 * 60 * 1000) {
      void s.transport.close();
      void s.server.close();
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.error("meta-ads-mcp listening on 0.0.0.0:" + PORT + MCP_PATH);
});
