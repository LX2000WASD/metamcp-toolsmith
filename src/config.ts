import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ENV = {
  toolsDir: "TOOLSMITH_TOOLS_DIR",
  writeToken: "TOOLSMITH_WRITE_TOKEN",
  bearerToken: "TOOLSMITH_BEARER_TOKEN",
  host: "TOOLSMITH_HOST",
  port: "TOOLSMITH_PORT",
  basePath: "TOOLSMITH_BASE_PATH",
  sessionTtlMs: "TOOLSMITH_SESSION_TTL_MS",
} as const;

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function resolveToolsDir(): string {
  const envValue = nonEmpty(process.env[ENV.toolsDir]);
  if (envValue) return path.resolve(envValue);
  return path.resolve(fileURLToPath(new URL("../tools", import.meta.url)));
}

export function resolveHost(): string {
  return nonEmpty(process.env[ENV.host]) ?? "0.0.0.0";
}

export function resolvePort(): number {
  const raw = nonEmpty(process.env[ENV.port]) ?? "7071";
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ${ENV.port}: ${raw}`);
  }
  return port;
}

export function resolveBasePath(): string {
  const raw = nonEmpty(process.env[ENV.basePath]);
  if (!raw) return "";
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeading.endsWith("/") ? withLeading.slice(0, -1) : withLeading;
}

export function resolveBearerToken(): string | undefined {
  return nonEmpty(process.env[ENV.bearerToken]);
}

export function resolveSessionTtlMs(): number {
  const raw = nonEmpty(process.env[ENV.sessionTtlMs]) ?? "600000"; // 10 minutes
  const ttl = Number.parseInt(raw, 10);
  if (!Number.isFinite(ttl) || ttl < 0) {
    throw new Error(`Invalid ${ENV.sessionTtlMs}: ${raw}`);
  }
  return ttl;
}

