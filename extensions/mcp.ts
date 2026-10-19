import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { TSchema } from "@earendil-works/pi-ai";
import type { McpServer } from "../src/settings.ts";

export async function connectMcp(name: string, server: McpServer, cwd: string, diagnostic = false) {
  const client = new Client({ name: "sage", version: "0.1.0" });
  const env = getDefaultEnvironment();
  env.PATH = fileURLToPath(new URL("../node_modules/.bin", import.meta.url)) + delimiter + (env.PATH ?? "");
  const requireEnv = (key: string) => {
    const value = process.env[key];
    if (!value) throw new Error(`Set ${key} before connecting MCP server ${name}.`);
    return value;
  };
  if ("command" in server) for (const key of server.env ?? []) env[key] = requireEnv(key);
  const transport = "url" in server
    ? new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: server.bearerTokenEnv ? { headers: { Authorization: `Bearer ${requireEnv(server.bearerTokenEnv)}` } } : undefined,
    })
    : new StdioClientTransport({ command: server.command, args: server.args, env, cwd, stderr: diagnostic ? "inherit" : "pipe" });
  // Keep child logs out of Pi's terminal renderer; do not retain potentially secret logs.
  if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
  try {
    await client.connect(transport, { timeout: 10000 });
    const tools = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await client.listTools({ cursor }, { timeout: 10000 });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("MCP server repeated a tool-list cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const names = new Set<string>();
    const extension = defineExtension({
      name: `mcp:${name}`,
      tools: tools.map((tool) => {
        const fullName = `mcp__${name}__${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        const toolName = fullName.length <= 64 ? fullName : fullName.slice(0, 51) + "_" + createHash("sha256").update(fullName).digest("hex").slice(0, 12);
        if (names.has(toolName)) throw new Error("MCP tool names collide after normalization.");
        names.add(toolName);
        return defineTool({
          name: toolName,
          description: tool.description ?? `${name}: ${tool.name}`,
          parameters: tool.inputSchema as TSchema,
          // External actions must never replay automatically after a crash.
          replay: "unsafe",
          execute: async (args, _api, context) => {
            const result = CallToolResultSchema.parse(await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, { signal: context.abortSignal, timeout: 60000 }));
            const output = (result.content ?? []).map((item) => {
              if (item.type === "text") return { type: "text" as const, text: item.text };
              if (item.type === "image") return { type: "image" as const, data: item.data, mimeType: item.mimeType };
              if (item.type === "resource" && "text" in item.resource) return { type: "text" as const, text: item.resource.text };
              return { type: "text" as const, text: `MCP returned unsupported content: ${item.type}` };
            });
            if (!output.length && result.structuredContent) output.push({ type: "text", text: JSON.stringify(result.structuredContent) });
            return { output, isError: result.isError === true };
          },
        });
      }),
    });
    return { extension, close: async () => {
      const timeout = setTimeout(() => { void client.close(); }, 3000);
      timeout.unref();
      try {
        if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) await transport.terminateSession();
      } finally { clearTimeout(timeout); await client.close(); }
    } };
  } catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw error;
  }
}
