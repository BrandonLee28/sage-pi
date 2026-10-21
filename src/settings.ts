import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

export const clientDataDir = () => process.env.CLIENT_DATA_DIR ?? join(homedir(), ".sage");

export type McpServer = { command: string; args: string[]; env?: string[] } | { url: string; bearerTokenEnv?: string };
export type Settings = {
  model?: { id: string; baseUrl: string; revision: string };
  mcpServers?: Record<string, McpServer>;
  gateway?: { url: string; token: string };
  voice?: { ttsModel: string };
};

export function gatewayUrl(value: string): string {
  const url = new URL(httpUrl(value));
  if (url.pathname !== "/" || url.search || url.hash)
    throw new Error("Use a gateway origin without a path or query.");
  return url.origin;
}

export function httpUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Use an HTTP(S) URL without embedded credentials.");
  return value.replace(/\/$/, "");
}

export function readSettings(dataDir: string): Settings {
  let value: Settings;
  try { value = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot read settings.json; fix the file before continuing.", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid settings.json.");
  if (value.voice !== undefined && (!value.voice || typeof value.voice.ttsModel !== "string" || !value.voice.ttsModel.trim()))
    throw new Error("Invalid saved voice model.");
  if (value.gateway !== undefined) {
    if (!value.gateway || typeof value.gateway.url !== "string" || typeof value.gateway.token !== "string" ||
      value.gateway.token.length < 32 || /\s/.test(value.gateway.token)) throw new Error("Invalid saved gateway connection.");
    gatewayUrl(value.gateway.url);
  }
  if (value.model !== undefined) {
    if (!value.model || typeof value.model.id !== "string" || !value.model.id.trim() || typeof value.model.revision !== "string" || !value.model.revision)
      throw new Error("Invalid model settings.");
    httpUrl(value.model.baseUrl);
  }
  if (value.mcpServers !== undefined) {
    if (!value.mcpServers || typeof value.mcpServers !== "object" || Array.isArray(value.mcpServers)) throw new Error("Invalid MCP settings.");
    for (const [name, server] of Object.entries(value.mcpServers)) validateServer(name, server);
  }
  return value;
}

export function validateServer(name: string, server: McpServer) {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) throw new Error("Server names use 1–40 letters, numbers, hyphens or underscores.");
  if (!server || typeof server !== "object") throw new Error("Invalid MCP server.");
  if ("url" in server) {
    if ("command" in server) throw new Error("Choose either an HTTP or stdio MCP server.");
    httpUrl(server.url);
    if (server.bearerTokenEnv !== undefined && (typeof server.bearerTokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(server.bearerTokenEnv))) throw new Error("Use an environment variable name for the bearer token.");
  } else if (typeof server.command !== "string" || !server.command.trim() || !Array.isArray(server.args) ||
      !server.args.every((arg) => typeof arg === "string") ||
      (server.env !== undefined && (!Array.isArray(server.env) || !server.env.every((key) => typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))))) {
    throw new Error("A stdio server needs a command, argument array, and optional environment variable names.");
  }
}

export async function saveSettings(dataDir: string, settings: Settings) {
  await mkdir(dataDir, { recursive: true });
  const temporary = join(dataDir, `settings-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, join(dataDir, "settings.json"));
}
