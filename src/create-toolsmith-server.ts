import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ToolLoader } from "./tool-loader";
import { createToolsmithHandlers, toolsmithTools } from "./toolsmith";

export function createToolsmithServer(params: { toolsDir: string }): {
  server: Server;
  toolLoader: ToolLoader;
} {
  const { toolsDir } = params;

  const server = new Server(
    { name: "toolsmith-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const toolLoader = new ToolLoader(toolsDir, {
    reservedNames: toolsmithTools.map((t) => t.name),
  });

  const toolsmithHandlers: Record<string, (args: unknown) => Promise<any>> =
    createToolsmithHandlers({ toolsDir, toolLoader });

  function isCallToolResult(value: unknown): value is { content: unknown[] } {
    return (
      !!value &&
      typeof value === "object" &&
      Array.isArray((value as any).content)
    );
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await toolLoader.refresh();
    const dynamicTools = toolLoader.getLoadedTools().map((t) => t.tool);
    return { tools: [...toolsmithTools, ...dynamicTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const builtin = toolsmithHandlers[name];
    if (builtin) {
      return await builtin(request.params.arguments);
    }

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

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return { server, toolLoader };
}

