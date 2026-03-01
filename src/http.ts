import { randomUUID } from "node:crypto";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Router } from "express";

import {
  resolveBasePath,
  resolveBearerToken,
  resolveHost,
  resolvePort,
  resolveSessionTtlMs,
  resolveToolsDir,
} from "./config";
import {
  createToolsmithAdminServer,
  createToolsmithServer,
  createToolsmithToolsServer,
} from "./create-toolsmith-server";
import { createBearerAuthMiddleware } from "./http-auth";
import { SessionStore } from "./session-store";

const toolsDir = resolveToolsDir();
const host = resolveHost();
const port = resolvePort();
const basePath = resolveBasePath();
const sessionTtlMs = resolveSessionTtlMs();
const bearerToken = resolveBearerToken();

const auth = createBearerAuthMiddleware(bearerToken);

const combinedSseSessions = new SessionStore<SSEServerTransport>(sessionTtlMs);
const combinedStreamableHttpSessions =
  new SessionStore<StreamableHTTPServerTransport>(sessionTtlMs);

const adminSseSessions = new SessionStore<SSEServerTransport>(sessionTtlMs);
const adminStreamableHttpSessions =
  new SessionStore<StreamableHTTPServerTransport>(sessionTtlMs);

const toolsSseSessions = new SessionStore<SSEServerTransport>(sessionTtlMs);
const toolsStreamableHttpSessions =
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

function registerSseRoutes(params: {
  router: Router;
  routePrefix: "" | "/admin" | "/tools";
  sessions: SessionStore<SSEServerTransport>;
  createServer: () => { server: Server };
}) {
  const { router, routePrefix, sessions, createServer } = params;

  // SSE transport (GET stream + POST message)
  router.get(`${routePrefix}/sse`, auth, async (req, res) => {
    const postEndpoint = `${req.baseUrl}${routePrefix}/message`;
    const transport = new SSEServerTransport(postEndpoint, res);
    const sessionId = transport.sessionId;

    sessions.set(sessionId, transport);

    res.on("close", () => {
      void sessions.closeAndDelete(sessionId).catch(() => undefined);
    });

    try {
      const { server } = createServer();
      await server.connect(transport);
    } catch (error) {
      await sessions.closeAndDelete(sessionId).catch(() => undefined);
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      res.status(500).json({ error: message });
    }
  });

  router.post(`${routePrefix}/message`, auth, async (req, res) => {
    try {
      const sessionId = getQuerySessionId(req.query.sessionId);
      if (!sessionId) {
        res.status(400).end("Missing sessionId");
        return;
      }

      const entry = sessions.get(sessionId);
      if (!entry) {
        res.status(404).end("Session not found");
        return;
      }

      sessions.touch(sessionId);
      await entry.transport.handlePostMessage(req, res);
    } catch (error) {
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      res.status(500).json({ error: message });
    }
  });
}

function registerStreamableHttpRoutes(params: {
  router: Router;
  routePrefix: "" | "/admin" | "/tools";
  sessions: SessionStore<StreamableHTTPServerTransport>;
  createServer: () => { server: Server };
}) {
  const { router, routePrefix, sessions, createServer } = params;

  // Streamable HTTP transport (single /mcp endpoint)
  router.get(`${routePrefix}/mcp`, auth, async (req, res) => {
    try {
      const sessionId = getHeaderSessionId(req.headers["mcp-session-id"]);
      if (!sessionId) {
        res.status(400).end("Missing mcp-session-id header");
        return;
      }

      const entry = sessions.get(sessionId);
      if (!entry) {
        res.status(404).end("Session not found");
        return;
      }

      sessions.touch(sessionId);
      await entry.transport.handleRequest(req, res);
    } catch (error) {
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      res.status(500).json({ error: message });
    }
  });

  router.post(`${routePrefix}/mcp`, auth, async (req, res) => {
    const sessionId = getHeaderSessionId(req.headers["mcp-session-id"]);

    if (!sessionId) {
      // New session
      const newSessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
      });

      sessions.set(newSessionId, transport);

      try {
        const { server } = createServer();
        await server.connect(transport);

        sessions.touch(newSessionId);
        await transport.handleRequest(req, res);
      } catch (error) {
        await sessions.closeAndDelete(newSessionId).catch(() => undefined);
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
      const entry = sessions.get(sessionId);
      if (!entry) {
        res.status(404).end("Session not found");
        return;
      }

      sessions.touch(sessionId);
      await entry.transport.handleRequest(req, res);
    } catch (error) {
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      res.status(500).json({ error: message });
    }
  });

  router.delete(`${routePrefix}/mcp`, auth, async (req, res) => {
    const sessionId = getHeaderSessionId(req.headers["mcp-session-id"]);
    if (!sessionId) {
      res.status(400).json({
        error: "Missing mcp-session-id header",
      });
      return;
    }

    try {
      const closed = await sessions.closeAndDelete(sessionId);
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
        combined: { sse: true, streamableHttp: true },
        admin: { sse: true, streamableHttp: true },
        tools: { sse: true, streamableHttp: true },
      },
    });
  });

  router.get("/health/sessions", auth, (_req, res) => {
    res.json({
      combined: {
        sse: {
          count: combinedSseSessions.getSessionIds().length,
          sessionIds: combinedSseSessions.getSessionIds(),
        },
        streamableHttp: {
          count: combinedStreamableHttpSessions.getSessionIds().length,
          sessionIds: combinedStreamableHttpSessions.getSessionIds(),
        },
      },
      admin: {
        sse: {
          count: adminSseSessions.getSessionIds().length,
          sessionIds: adminSseSessions.getSessionIds(),
        },
        streamableHttp: {
          count: adminStreamableHttpSessions.getSessionIds().length,
          sessionIds: adminStreamableHttpSessions.getSessionIds(),
        },
      },
      tools: {
        sse: {
          count: toolsSseSessions.getSessionIds().length,
          sessionIds: toolsSseSessions.getSessionIds(),
        },
        streamableHttp: {
          count: toolsStreamableHttpSessions.getSessionIds().length,
          sessionIds: toolsStreamableHttpSessions.getSessionIds(),
        },
      },
      ttlMs: sessionTtlMs,
    });
  });

  registerSseRoutes({
    router,
    routePrefix: "",
    sessions: combinedSseSessions,
    createServer: () => createToolsmithServer({ toolsDir }),
  });

  registerStreamableHttpRoutes({
    router,
    routePrefix: "",
    sessions: combinedStreamableHttpSessions,
    createServer: () => createToolsmithServer({ toolsDir }),
  });

  registerSseRoutes({
    router,
    routePrefix: "/admin",
    sessions: adminSseSessions,
    createServer: () => createToolsmithAdminServer({ toolsDir }),
  });

  registerStreamableHttpRoutes({
    router,
    routePrefix: "/admin",
    sessions: adminStreamableHttpSessions,
    createServer: () => createToolsmithAdminServer({ toolsDir }),
  });

  registerSseRoutes({
    router,
    routePrefix: "/tools",
    sessions: toolsSseSessions,
    createServer: () => createToolsmithToolsServer({ toolsDir }),
  });

  registerStreamableHttpRoutes({
    router,
    routePrefix: "/tools",
    sessions: toolsStreamableHttpSessions,
    createServer: () => createToolsmithToolsServer({ toolsDir }),
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
      void combinedSseSessions.cleanupExpired();
      void combinedStreamableHttpSessions.cleanupExpired();
      void adminSseSessions.cleanupExpired();
      void adminStreamableHttpSessions.cleanupExpired();
      void toolsSseSessions.cleanupExpired();
      void toolsStreamableHttpSessions.cleanupExpired();
    }, cleanupIntervalMs);
    cleanupTimer.unref();
  }

  const httpServer = app.listen(port, host, () => {
    const prefix = basePath || "";
    console.log(
      `Toolsmith MCP Server listening on http://${host}:${port}${prefix}`,
    );
    console.log(`- SSE (combined):  http://${host}:${port}${prefix}/sse`);
    console.log(`- SSE (admin):     http://${host}:${port}${prefix}/admin/sse`);
    console.log(`- SSE (tools):     http://${host}:${port}${prefix}/tools/sse`);
    console.log(
      `- HTTP (combined): http://${host}:${port}${prefix}/mcp`,
    );
    console.log(
      `- HTTP (admin):    http://${host}:${port}${prefix}/admin/mcp`,
    );
    console.log(
      `- HTTP (tools):    http://${host}:${port}${prefix}/tools/mcp`,
    );
    console.log(`- Tools dir:       ${toolsDir}`);
    console.log(
      `- Bearer auth:     ${bearerToken ? "enabled" : "disabled"}`,
    );
  });

  async function shutdown(signal: string) {
    console.log(`Received ${signal}, shutting down...`);
    if (cleanupTimer) clearInterval(cleanupTimer);
    await combinedSseSessions.closeAll().catch(() => undefined);
    await combinedStreamableHttpSessions.closeAll().catch(() => undefined);
    await adminSseSessions.closeAll().catch(() => undefined);
    await adminStreamableHttpSessions.closeAll().catch(() => undefined);
    await toolsSseSessions.closeAll().catch(() => undefined);
    await toolsStreamableHttpSessions.closeAll().catch(() => undefined);
    httpServer.close();
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

await start();
