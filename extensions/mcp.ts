import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { TSchema } from "@earendil-works/pi-ai";
import type { McpServer } from "../src/settings.ts";

// Keep common Cua browser tools ready; Pi's native tool_search loads the rest on demand.
const desktopTools = new Set([
  "get_browser_state", "browser_prepare", "browser_navigate", "browser_click",
  "browser_type", "list_windows", "get_guide", "get_desktop_state",
]);

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
      sections: name === "desktop" ? [section("desktop_tools", () =>
        "Prefer direct service tools for information they can provide. For browser work, prefer Cua's typed browser tools " +
        "over repeated desktop screenshots and coordinate clicks. Use get_browser_state with snapshot_format=semantic_v2 " +
        "and a query for the next decision (such as a control's name or role), or scope_ref for its subtree. " +
        "Do not read the entire page to locate one control; widen only when a focused read misses it. " +
        "Omit screenshots when page text and action refs are sufficient. " +
        "Navigate directly with browser_navigate once a target/tab is bound; pass the same explicit session label on every call " +
        "and use fresh returned refs. " +
        "Use get_guide topic=browser for setup or recovery. If a route is unavailable, follow its recovery hint rather than repeating it. " +
        "Additional desktop tools are available through tool_search, including get_window_state, native input, run_steps and run_script. " +
        "For a known tool, search its exact name with limit=1; load only the tools needed for the next step. " +
        "For native windows, prefer bounded trees and include_screenshot=false when re-indexing is sufficient; " +
        "request screenshots when visual evidence is needed. Batch already-grounded actions with run_steps where suitable, " +
        "verify the result, and preserve permission and confirmation requirements. " +
        "Report the requested outcome briefly; omit internal IDs, refs, and inventories of controls unless asked.",
      )] : [],
      tools: tools.map((tool) => {
        const fullName = `mcp__${name}__${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        const toolName = fullName.length <= 64 ? fullName : fullName.slice(0, 51) + "_" + createHash("sha256").update(fullName).digest("hex").slice(0, 12);
        if (names.has(toolName)) throw new Error("MCP tool names collide after normalization.");
        names.add(toolName);
        return defineTool({
          name: toolName,
          description: tool.description ?? `${name}: ${tool.name}`,
          parameters: tool.inputSchema as TSchema,
          ...(name === "desktop" && !desktopTools.has(tool.name) ? { deferred: true as const } : {}),
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
            // Cua's text can be only a summary; its live tab IDs and action refs are structured.
            if (result.structuredContent) {
              const text = JSON.stringify(result.structuredContent);
              if (!output.some((item) => item.type === "text" && item.text === text))
                output.push({ type: "text", text });
            }
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
