import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export interface ToolExecutionContext {
  toolsDir: string;
}

export type ToolHandler = (
  args: unknown,
  ctx: ToolExecutionContext,
) => Promise<unknown>;

export interface LoadedTool {
  filePath: string;
  mtimeMs: number;
  tool: Tool;
  handler: ToolHandler;
}

export interface ToolLoadError {
  filePath: string;
  mtimeMs?: number;
  error: string;
}

export interface ToolLoaderStatus {
  loadedTools: Array<Pick<LoadedTool, "filePath" | "mtimeMs" | "tool">>;
  errors: ToolLoadError[];
}

export class ToolLoader {
  private readonly toolsDir: string;
  private readonly reservedNames: Set<string>;

  private readonly loadedByName = new Map<string, LoadedTool>();
  private readonly fileMeta = new Map<string, { mtimeMs: number; toolName?: string }>();
  private readonly errorsByFile = new Map<string, ToolLoadError>();

  constructor(toolsDir: string, options?: { reservedNames?: Iterable<string> }) {
    this.toolsDir = toolsDir;
    this.reservedNames = new Set(options?.reservedNames ?? []);
  }

  getToolsDir(): string {
    return this.toolsDir;
  }

  getLoadedTool(name: string): LoadedTool | undefined {
    return this.loadedByName.get(name);
  }

  getLoadedTools(): LoadedTool[] {
    return Array.from(this.loadedByName.values()).sort((a, b) =>
      a.tool.name.localeCompare(b.tool.name),
    );
  }

  getStatus(): ToolLoaderStatus {
    return {
      loadedTools: this.getLoadedTools().map(({ filePath, mtimeMs, tool }) => ({
        filePath,
        mtimeMs,
        tool,
      })),
      errors: Array.from(this.errorsByFile.values()).sort((a, b) =>
        a.filePath.localeCompare(b.filePath),
      ),
    };
  }

  async refresh(options?: { force?: boolean }): Promise<void> {
    const force = options?.force ?? false;

    let dirEntries: Array<{ name: string; isFile: () => boolean }>;
    try {
      dirEntries = await fs.readdir(this.toolsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return;
      }
      throw error;
    }

    const mjsFiles = dirEntries
      .filter((ent) => ent.isFile() && ent.name.endsWith(".mjs"))
      .map((ent) => path.join(this.toolsDir, ent.name));

    const currentFiles = new Map<string, number>();
    const statErrors = new Map<string, string>();
    await Promise.allSettled(
      mjsFiles.map(async (filePath) => {
        try {
          const stat = await fs.stat(filePath);
          currentFiles.set(filePath, stat.mtimeMs);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          // File might disappear between readdir() and stat() — ignore.
          if (code === "ENOENT") {
            return;
          }
          const message =
            error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          statErrors.set(filePath, message);
        }
      }),
    );

    const existingFiles = new Set<string>([
      ...currentFiles.keys(),
      ...statErrors.keys(),
    ]);

    let structuralChange = force;

    // Unload deleted files
    for (const filePath of this.fileMeta.keys()) {
      if (!existingFiles.has(filePath)) {
        structuralChange = true;
        this.unloadFile(filePath);
      }
    }

    // Track changed files
    for (const [filePath, mtimeMs] of currentFiles.entries()) {
      const previous = this.fileMeta.get(filePath);
      const changed = !previous || previous.mtimeMs !== mtimeMs;
      if (changed) structuralChange = true;
    }

    // Record stat() errors (and unload any previously loaded tool from those files)
    for (const [filePath, error] of statErrors.entries()) {
      structuralChange = true;
      this.unloadFile(filePath);
      this.fileMeta.set(filePath, { mtimeMs: 0 });
      this.errorsByFile.set(filePath, { filePath, error });
    }

    // Load/Reload changed files
    for (const [filePath, mtimeMs] of Array.from(currentFiles.entries()).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      const previous = this.fileMeta.get(filePath);
      const changed = !previous || previous.mtimeMs !== mtimeMs;
      const hadError = this.errorsByFile.has(filePath);

      if (!force && !changed && !(structuralChange && hadError)) {
        continue;
      }

      await this.loadFile(filePath, mtimeMs);
    }
  }

  private unloadFile(filePath: string): void {
    const previous = this.fileMeta.get(filePath);
    if (previous?.toolName) {
      this.loadedByName.delete(previous.toolName);
    }
    this.fileMeta.delete(filePath);
    this.errorsByFile.delete(filePath);
  }

  private async loadFile(filePath: string, mtimeMs: number): Promise<void> {
    // Remove any previous mapping for this file so renames/updates don't leave stale entries.
    this.unloadFile(filePath);

    try {
      const moduleUrl = pathToFileURL(filePath);
      moduleUrl.searchParams.set("v", String(mtimeMs));

      const mod = (await import(moduleUrl.href)) as unknown;
      const tool = (mod as any)?.tool as Tool | undefined;
      const handler = (mod as any)?.handler as ToolHandler | undefined;

      if (!tool || typeof tool !== "object") {
        throw new Error(`Missing export "tool"`);
      }
      if (typeof tool.name !== "string" || tool.name.trim() === "") {
        throw new Error(`Invalid tool.name`);
      }
      if (tool.name.includes("__")) {
        throw new Error(`tool.name must not include "__"`);
      }
      if (tool.name.startsWith("toolsmith_")) {
        throw new Error(`tool.name must not start with "toolsmith_"`);
      }
      if (!/^[a-z0-9_]+$/.test(tool.name)) {
        throw new Error(`tool.name must match /^[a-z0-9_]+$/`);
      }
      if (this.reservedNames.has(tool.name)) {
        throw new Error(`tool.name "${tool.name}" is reserved`);
      }
      if (typeof handler !== "function") {
        throw new Error(`Missing export "handler"`);
      }

      if (this.loadedByName.has(tool.name)) {
        throw new Error(`Duplicate tool.name "${tool.name}"`);
      }

      const loaded: LoadedTool = {
        filePath,
        mtimeMs,
        tool,
        handler,
      };

      this.loadedByName.set(tool.name, loaded);
      this.fileMeta.set(filePath, { mtimeMs, toolName: tool.name });
      this.errorsByFile.delete(filePath);
    } catch (error) {
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);

      this.fileMeta.set(filePath, { mtimeMs });
      this.errorsByFile.set(filePath, { filePath, mtimeMs, error: message });
    }
  }
}
