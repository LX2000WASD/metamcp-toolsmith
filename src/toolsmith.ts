import type {
  CallToolResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ToolLoader } from "./tool-loader";

const WRITE_TOKEN_ENV = "TOOLSMITH_WRITE_TOKEN";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function textResult(text: string, isError: boolean = false): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function requireWriteAuth(args: Record<string, unknown>): CallToolResult | null {
  const expected = process.env[WRITE_TOKEN_ENV];
  if (!expected) {
    return null;
  }

  const token = args.writeToken;
  if (typeof token !== "string" || token !== expected) {
    return textResult(
      `Write access denied. Provide correct "writeToken" (env: ${WRITE_TOKEN_ENV}).`,
      true,
    );
  }
  return null;
}

function validateToolName(name: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof name !== "string") {
    return { ok: false, error: `"name" must be a string` };
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: `"name" must not be empty` };
  }

  if (trimmed.includes("__")) {
    return { ok: false, error: `"name" must not include "__"` };
  }

  if (!/^[a-z0-9_]+$/.test(trimmed)) {
    return {
      ok: false,
      error: `"name" must match /^[a-z0-9_]+$/`,
    };
  }

  if (trimmed.startsWith("toolsmith_")) {
    return {
      ok: false,
      error: `"name" must not start with "toolsmith_" (reserved)`,
    };
  }

  return { ok: true, name: trimmed };
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${randomUUID()}`,
  );
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
}

function generateTemplateModule(params: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): string {
  const toolObject = {
    name: params.name,
    description: params.description,
    inputSchema: params.inputSchema,
  };

  const toolJson = JSON.stringify(toolObject, null, 2);
  return [
    `export const tool = ${toolJson};`,
    ``,
    `export async function handler(args) {`,
    `  return {`,
    `    content: [`,
    `      {`,
    `        type: "text",`,
    `        text: JSON.stringify(args ?? {}, null, 2)`,
    `      }`,
    `    ]`,
    `  };`,
    `}`,
    ``,
  ].join("\n");
}

export const toolsmithTools: Tool[] = [
  {
    name: "toolsmith_ping",
    description: "Healthcheck tool for local-tools-server.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "toolsmith_create_tool",
    description:
      "Create a new local tool module under the tools directory (default: template mode).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Tool name (^[a-z0-9_]+$, no "__", must not start with "toolsmith_").',
        },
        description: { type: "string", description: "Tool description." },
        mode: {
          type: "string",
          enum: ["template", "raw"],
          description: 'Generation mode: "template" or "raw".',
        },
        inputSchema: {
          type: "object",
          description: "JSON Schema for tool input (template mode).",
        },
        fileContent: {
          type: "string",
          description: "Full module content (raw mode).",
        },
        overwrite: {
          type: "boolean",
          description: "Overwrite if file exists (default false).",
        },
        writeToken: {
          type: "string",
          description: `Write token if ${WRITE_TOKEN_ENV} is set.`,
        },
      },
      required: ["name"],
    },
  },
  {
    name: "toolsmith_update_tool",
    description:
      "Update an existing local tool module (template or raw).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        mode: { type: "string", enum: ["template", "raw"] },
        inputSchema: { type: "object" },
        fileContent: { type: "string" },
        createIfMissing: {
          type: "boolean",
          description: "Create file if missing (default false).",
        },
        writeToken: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "toolsmith_read_tool",
    description: "Read a local tool module source code.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "toolsmith_delete_tool",
    description: "Delete a local tool module file.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        writeToken: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "toolsmith_list_local_tools",
    description: "List loaded tools and load errors (with file paths).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "toolsmith_reload_tools",
    description: "Force reload tools from disk (bust ESM import cache).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "toolsmith_get_tools_dir",
    description: "Get tools directory path.",
    inputSchema: { type: "object", properties: {} },
  },
];

export function createToolsmithHandlers(params: {
  toolsDir: string;
  toolLoader: ToolLoader;
}): Record<string, (args: unknown) => Promise<CallToolResult>> {
  const { toolsDir, toolLoader } = params;

  return {
    async toolsmith_ping() {
      return textResult("pong");
    },

    async toolsmith_get_tools_dir() {
      return textResult(toolsDir);
    },

    async toolsmith_list_local_tools() {
      await toolLoader.refresh();
      const status = toolLoader.getStatus();
      return textResult(JSON.stringify(status, null, 2));
    },

    async toolsmith_reload_tools() {
      await toolLoader.refresh({ force: true });
      const status = toolLoader.getStatus();
      return textResult(JSON.stringify(status, null, 2));
    },

    async toolsmith_read_tool(rawArgs: unknown) {
      const args = asObject(rawArgs);
      const validated = validateToolName(args.name);
      if (!validated.ok) return textResult(validated.error, true);

      const filePath = path.join(toolsDir, `${validated.name}.mjs`);
      try {
        const content = await fs.readFile(filePath, "utf8");
        return textResult(content);
      } catch (error) {
        const message =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return textResult(message, true);
      }
    },

    async toolsmith_delete_tool(rawArgs: unknown) {
      const args = asObject(rawArgs);
      const denied = requireWriteAuth(args);
      if (denied) return denied;

      const validated = validateToolName(args.name);
      if (!validated.ok) return textResult(validated.error, true);

      const filePath = path.join(toolsDir, `${validated.name}.mjs`);
      try {
        await fs.unlink(filePath);
        await toolLoader.refresh({ force: true });
        return textResult(`Deleted ${path.basename(filePath)}`);
      } catch (error) {
        const message =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return textResult(message, true);
      }
    },

    async toolsmith_create_tool(rawArgs: unknown) {
      const args = asObject(rawArgs);
      const denied = requireWriteAuth(args);
      if (denied) return denied;

      const validated = validateToolName(args.name);
      if (!validated.ok) return textResult(validated.error, true);

      const mode = args.mode === "raw" ? "raw" : "template";
      const overwrite = args.overwrite === true;

      const filePath = path.join(toolsDir, `${validated.name}.mjs`);
      try {
        let existing = true;
        try {
          await fs.stat(filePath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
            existing = false;
          } else {
            throw e;
          }
        }

        if (existing && !overwrite) {
          return textResult(
            `Tool file already exists: ${path.basename(filePath)} (set overwrite=true to replace)`,
            true,
          );
        }

        let content: string;
        if (mode === "raw") {
          if (typeof args.fileContent !== "string" || args.fileContent.trim() === "") {
            return textResult(`"fileContent" is required in raw mode`, true);
          }
          content = args.fileContent;
        } else {
          const description =
            typeof args.description === "string" ? args.description : "";
          const inputSchema =
            typeof args.inputSchema === "object" && args.inputSchema && !Array.isArray(args.inputSchema)
              ? (args.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} };
          content = generateTemplateModule({
            name: validated.name,
            description,
            inputSchema,
          });
        }

        await writeFileAtomic(filePath, content);
        await toolLoader.refresh({ force: true });

        const loaded = toolLoader.getLoadedTool(validated.name);
        if (!loaded) {
          const status = toolLoader.getStatus();
          return textResult(
            `Tool file written but failed to load. Check toolsmith_list_local_tools.\n\n${JSON.stringify(status, null, 2)}`,
            true,
          );
        }

        return textResult(`Created ${path.basename(filePath)}`);
      } catch (error) {
        const message =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return textResult(message, true);
      }
    },

    async toolsmith_update_tool(rawArgs: unknown) {
      const args = asObject(rawArgs);
      const denied = requireWriteAuth(args);
      if (denied) return denied;

      const validated = validateToolName(args.name);
      if (!validated.ok) return textResult(validated.error, true);

      const mode = args.mode === "raw" ? "raw" : "template";
      const createIfMissing = args.createIfMissing === true;

      const filePath = path.join(toolsDir, `${validated.name}.mjs`);
      try {
        let existing = true;
        try {
          await fs.stat(filePath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
            existing = false;
          } else {
            throw e;
          }
        }

        if (!existing && !createIfMissing) {
          return textResult(
            `Tool file does not exist: ${path.basename(filePath)} (set createIfMissing=true to create)`,
            true,
          );
        }

        let content: string;
        if (mode === "raw") {
          if (typeof args.fileContent !== "string" || args.fileContent.trim() === "") {
            return textResult(`"fileContent" is required in raw mode`, true);
          }
          content = args.fileContent;
        } else {
          const description =
            typeof args.description === "string" ? args.description : "";
          const inputSchema =
            typeof args.inputSchema === "object" && args.inputSchema && !Array.isArray(args.inputSchema)
              ? (args.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} };
          content = generateTemplateModule({
            name: validated.name,
            description,
            inputSchema,
          });
        }

        await writeFileAtomic(filePath, content);
        await toolLoader.refresh({ force: true });

        const loaded = toolLoader.getLoadedTool(validated.name);
        if (!loaded) {
          const status = toolLoader.getStatus();
          return textResult(
            `Tool file updated but failed to load. Check toolsmith_list_local_tools.\n\n${JSON.stringify(status, null, 2)}`,
            true,
          );
        }

        return textResult(`Updated ${path.basename(filePath)}`);
      } catch (error) {
        const message =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return textResult(message, true);
      }
    },
  };
}
