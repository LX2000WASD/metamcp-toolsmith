import { randomUUID } from "node:crypto";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import {
  resolveBasePath,
  resolveBearerToken,
  resolveHost,
  resolvePort,
  resolveSessionTtlMs,
  resolveToolsDir,
} from "./config";
import { createToolsmithServer } from "./create-toolsmith-server";
import { createBearerAuthMiddleware } from "./http-auth";
import { SessionStore } from "./session-store";

const toolsDir = resolveToolsDir();
const host = resolveHost();
const port = resolvePort();
const basePath = resolveBasePath();
const sessionTtlMs = resolveSessionTtlMs();
const bearerToken = resolveBearerToken();

const auth = createBearerAuthMiddleware(bearerToken);

const sseSessions = new SessionStore<SSEServerTransport>(sessionTtlMs);
const streamableHttpSessions =
  new SessionStore<StreamableHTTPServerTransport>(sessionTtlMs);

function getHeaderSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getQuerySessionId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

async function start(): Promise<void> {
  const app = express();
  app.disable("x-powered-by");

  // Do NOT attach express.json() globally: MCP transports need raw request streams.

  const router = express.Router();

  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      name: "toolsmith-mcp-server",
      toolsDir,
      transports: {
        sse: true,
        streamableHttp: true,
      },
    });
  });

  router.get("/health/sessions", auth, (_req, res) => {
    res.json({
      sse: {
        count: sseSessions.getSessionIds().length,
        sessionIds: sseSessions.getSessionIds(),
      },
      streamableHttp: {
        count: streamableHttpSessions.getSessionIds().length,
        sessionIds: streamableHttpSessions.getSessionIds(),
      },
      ttlMs: sessionTtlMs,
    });
  });

  // SSE transport (GET stream + POST message)
  router.get("/sse", auth, async (req, res) => {
    const postEndpoint = `${req.baseUrl}/message`;
    const transport = new SSEServerTransport(postEndpoint, res);
    const sessionId = transport.sessionId;

    sseSessions.set(sessionId, transport);

    res.on("close", () => {
      void sseSessions.closeAndDelete(sessionId).catch(() => undefined);
    });

    try {
      const { server } = createToolsmithServer({ toolsDir });
      await server.connect(transport);
    } catch (error) {
      await sseSessions.closeAndDelete(sessionId).catch(() => undefined);
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      res.status(500).json({ error: message });
    }
  });

  router.post("/message", auth, async (req, res) => {
    try {
      const sessionId = getQuerySessionId(req.query.sessionId);
      if (!sessionId) {
        res.status(400).end("Missing sessionId");
        return;
      }

      const entry = sseSessions.get(sessionId);
      if (!entry) {
        res.status(404).end("Session not found");
        return;
      }

      sseSessions.touch(sessionId);
      await entry.transport.handlePostMessage(req, res);
    } catch (error) {
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      res.status(500).json({ error: message });
    }
  });

  // Streamable HTTP transport (single /mcp endpoint)
  router.get("/mcp", auth, async (req, res) => {
    try {
      const sessionId = getHeaderSessionId(req.headers["mcp-session-id"]);
      if (!sessionId) {
        res.status(400).end("Missing mcp-session-id header");
        return;
      }

      const entry = streamableHttpSessions.get(sessionId);
      if (!entry) {
        res.status(404).end("Session not found");
        return;
      }

      streamableHttpSessions.touch(sessionId);
      await entry.transport.handleRequest(req, res);
    } catch (error) {
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      res.status(500).json({ error: message });
    }
  });

  router.post("/mcp", auth, async (req, res) => {
    const sessionId = getHeaderSessionId(req.headers["mcp-session-id"]);

    if (!sessionId) {
      // New session
      const newSessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
      });

      streamableHttpSessions.set(newSessionId, transport);

      try {
        const { server } = createToolsmithServer({ toolsDir });
        await server.connect(transport);

        streamableHttpSessions.touch(newSessionId);
        await transport.handleRequest(req, res);
      } catch (error) {
        await streamableHttpSessions.closeAndDelete(newSessionId).catch(
          () => undefined,
        );
        const message =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        res.status(500).json({ error: message });
      }

      return;
    }

    // Existing session
    try {
      const entry = streamableHttpSessions.get(sessionId);
      if (!entry) {
        res.status(404).end("Session not found");
        return;
      }

      streamableHttpSessions.touch(sessionId);
      await entry.transport.handleRequest(req, res);
    } catch (error) {
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      res.status(500).json({ error: message });
    }
  });

  router.delete("/mcp", auth, async (req, res) => {
    const sessionId = getHeaderSessionId(req.headers["mcp-session-id"]);
    if (!sessionId) {
      res.status(400).json({
        error: "Missing mcp-session-id header",
      });
      return;
    }

    try {
      const closed = await streamableHttpSessions.closeAndDelete(sessionId);
      if (!closed) {
        res.status(404).end("Session not found");
        return;
      }

      res.json({ status: "ok" });
    } catch (error) {
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      res.status(500).json({ error: message });
    }
  });

  if (basePath) {
    app.use(basePath, router);
  } else {
    app.use(router);
  }

  const cleanupIntervalMs =
    sessionTtlMs > 0 ? Math.min(60_000, Math.max(5_000, sessionTtlMs)) : 0;

  let cleanupTimer: NodeJS.Timeout | undefined;
  if (cleanupIntervalMs > 0) {
    cleanupTimer = setInterval(() => {
      void sseSessions.cleanupExpired();
      void streamableHttpSessions.cleanupExpired();
    }, cleanupIntervalMs);
    cleanupTimer.unref();
  }

  const httpServer = app.listen(port, host, () => {
    const prefix = basePath || "";
    console.log(
      `Toolsmith MCP Server listening on http://${host}:${port}${prefix}`,
    );
    console.log(`- SSE:            http://${host}:${port}${prefix}/sse`);
    console.log(`- Streamable HTTP: http://${host}:${port}${prefix}/mcp`);
    console.log(`- Tools dir:       ${toolsDir}`);
    console.log(
      `- Bearer auth:     ${bearerToken ? "enabled" : "disabled"}`,
    );
  });

  async function shutdown(signal: string) {
    console.log(`Received ${signal}, shutting down...`);
    if (cleanupTimer) clearInterval(cleanupTimer);
    await sseSessions.closeAll().catch(() => undefined);
    await streamableHttpSessions.closeAll().catch(() => undefined);
    httpServer.close();
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

await start();
