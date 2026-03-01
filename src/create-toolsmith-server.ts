import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ToolLoader } from "./tool-loader";
import { createToolsmithHandlers, toolsmithTools } from "./toolsmith";

type ToolsmithServerMode = "all" | "admin" | "tools";

function createServer(params: { toolsDir: string; mode: ToolsmithServerMode }): {
  server: Server;
  toolLoader: ToolLoader;
} {
  const { toolsDir, mode } = params;

  const server = new Server(
    {
      name:
        mode === "admin"
          ? "toolsmith-mcp-admin"
          : mode === "tools"
            ? "toolsmith-mcp-tools"
            : "toolsmith-mcp-server",
      version: "0.2.0",
    },
    { capabilities: { tools: {} } },
  );

  const toolLoader = new ToolLoader(toolsDir, {
    reservedNames: toolsmithTools.map((t) => t.name),
  });

  const toolsmithHandlers: Record<string, (args: unknown) => Promise<any>> =
    mode === "tools" ? {} : createToolsmithHandlers({ toolsDir, toolLoader });

  function isCallToolResult(value: unknown): value is { content: unknown[] } {
    return (
      !!value &&
      typeof value === "object" &&
      Array.isArray((value as any).content)
    );
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (mode === "admin") {
      return { tools: toolsmithTools };
    }

    await toolLoader.refresh();
    const dynamicTools = toolLoader.getLoadedTools().map((t) => t.tool);

    if (mode === "tools") {
      return { tools: dynamicTools };
    }

    return { tools: [...toolsmithTools, ...dynamicTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (mode !== "tools") {
      const builtin = toolsmithHandlers[name];
      if (builtin) {
        return await builtin(request.params.arguments);
      }
    }

    if (mode !== "admin") {
      await toolLoader.refresh();
      const loaded = toolLoader.getLoadedTool(name);
      if (loaded) {
        try {
          const result = await loaded.handler(request.params.arguments, {
            toolsDir,
          });
          if (isCallToolResult(result)) {
            return result as any;
          }
          return {
            content: [
              {
                type: "text",
                text:
                  typeof result === "string"
                    ? result
                    : JSON.stringify(result ?? "", null, 2),
              },
            ],
          };
        } catch (error) {
          const message =
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error);
          return {
            content: [{ type: "text", text: message }],
            isError: true,
          };
        }
      }
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return { server, toolLoader };
}

export function createToolsmithServer(params: { toolsDir: string }): {
  server: Server;
  toolLoader: ToolLoader;
} {
  return createServer({ ...params, mode: "all" });
}

export function createToolsmithAdminServer(params: { toolsDir: string }): {
  server: Server;
  toolLoader: ToolLoader;
} {
  return createServer({ ...params, mode: "admin" });
}

export function createToolsmithToolsServer(params: { toolsDir: string }): {
  server: Server;
  toolLoader: ToolLoader;
} {
  return createServer({ ...params, mode: "tools" });
}
