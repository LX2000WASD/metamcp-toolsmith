import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ToolLoader } from "./tool-loader";

async function writeToolFile(
  dir: string,
  fileBaseName: string,
  content: string,
): Promise<string> {
  const filePath = path.join(dir, `${fileBaseName}.mjs`);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

describe("ToolLoader", () => {
  it("loads valid .mjs tools and exposes them by name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-loader-"));
    await writeToolFile(
      dir,
      "hello",
      [
        `export const tool = {`,
        `  name: "hello",`,
        `  description: "Hello tool",`,
        `  inputSchema: { type: "object", properties: {} }`,
        `};`,
        `export async function handler() {`,
        `  return { content: [{ type: "text", text: "ok" }] };`,
        `}`,
      ].join("\n"),
    );

    const loader = new ToolLoader(dir);
    await loader.refresh();

    const loaded = loader.getLoadedTool("hello");
    expect(loaded).toBeTruthy();
    expect(loaded?.tool.name).toBe("hello");
    expect(loader.getStatus().errors).toHaveLength(0);
  });

  it("rejects reserved toolsmith_ prefix and reports an error", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-loader-"));
    await writeToolFile(
      dir,
      "bad",
      [
        `export const tool = {`,
        `  name: "toolsmith_bad",`,
        `  description: "Bad tool",`,
        `  inputSchema: { type: "object", properties: {} }`,
        `};`,
        `export async function handler() {`,
        `  return { content: [{ type: "text", text: "nope" }] };`,
        `}`,
      ].join("\n"),
    );

    const loader = new ToolLoader(dir);
    await loader.refresh();

    expect(loader.getLoadedTool("toolsmith_bad")).toBeUndefined();
    expect(loader.getStatus().errors.length).toBe(1);
  });

  it("reloads tools when file mtime changes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-loader-"));
    const filePath = await writeToolFile(
      dir,
      "reload_me",
      [
        `export const tool = {`,
        `  name: "reload_me",`,
        `  description: "v1",`,
        `  inputSchema: { type: "object", properties: {} }`,
        `};`,
        `export async function handler() {`,
        `  return { content: [{ type: "text", text: "v1" }] };`,
        `}`,
      ].join("\n"),
    );

    const loader = new ToolLoader(dir);
    await loader.refresh();
    expect(loader.getLoadedTool("reload_me")?.tool.description).toBe("v1");

    // Ensure mtime changes on fast filesystems.
    await new Promise((r) => setTimeout(r, 10));

    await fs.writeFile(
      filePath,
      [
        `export const tool = {`,
        `  name: "reload_me",`,
        `  description: "v2",`,
        `  inputSchema: { type: "object", properties: {} }`,
        `};`,
        `export async function handler() {`,
        `  return { content: [{ type: "text", text: "v2" }] };`,
        `}`,
      ].join("\n"),
      "utf8",
    );

    await loader.refresh();
    expect(loader.getLoadedTool("reload_me")?.tool.description).toBe("v2");
  });

  it("retries previously errored tools after structural changes (e.g. duplicate resolved)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-loader-"));
    const fileA = await writeToolFile(
      dir,
      "a",
      [
        `export const tool = {`,
        `  name: "dup",`,
        `  description: "from a",`,
        `  inputSchema: { type: "object", properties: {} }`,
        `};`,
        `export async function handler() {`,
        `  return { content: [{ type: "text", text: "a" }] };`,
        `}`,
      ].join("\n"),
    );
    await writeToolFile(
      dir,
      "b",
      [
        `export const tool = {`,
        `  name: "dup",`,
        `  description: "from b",`,
        `  inputSchema: { type: "object", properties: {} }`,
        `};`,
        `export async function handler() {`,
        `  return { content: [{ type: "text", text: "b" }] };`,
        `}`,
      ].join("\n"),
    );

    const loader = new ToolLoader(dir);
    await loader.refresh();

    // One loads, one errors (duplicate).
    expect(loader.getLoadedTool("dup")).toBeTruthy();
    expect(loader.getStatus().errors.length).toBe(1);

    // Remove one file; refresh should retry the previously errored one.
    await fs.unlink(fileA);
    await loader.refresh();

    expect(loader.getLoadedTool("dup")).toBeTruthy();
    expect(loader.getStatus().errors.length).toBe(0);
  });
});
