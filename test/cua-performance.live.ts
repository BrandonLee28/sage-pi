// Explicit opt-in. Reads MCP tool metadata and calls the configured model; executes no desktop actions.
import { connectMcp } from "../extensions/mcp.ts";
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";
import { readConfig } from "../src/config.ts";

if (!process.env.CUA_MCP_URL) throw new Error("Set CUA_MCP_URL to a reachable test desktop MCP endpoint.");
const config = readConfig();
const connection = await connectMcp("desktop", {
  url: process.env.CUA_MCP_URL,
  ...(process.env.CUA_ENV_TOKEN ? { bearerTokenEnv: "CUA_ENV_TOKEN" } : {}),
}, process.cwd());
try {
  const all = connection.extension.tools ?? [];
  for (const focused of [false, true]) {
    const offered = focused ? [...all.filter((tool) => !tool.deferred), createToolSearchTool()] : all;
    const tools = offered.map((tool) => ({ type: "function", function: {
      name: tool.name, description: tool.description, parameters: tool.parameters,
    } }));
    for (const attempt of ["first", "repeat"]) {
      const started = performance.now();
      const response = await fetch(config.baseUrl + "/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.modelId, tools, tool_choice: "auto", max_tokens: 96, temperature: 0,
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            { role: "system", content: "You operate an isolated Linux desktop. Use tools to observe before acting. Be concise." },
            { role: "user", content: "Inspect the desktop now using get_desktop_state. Do not open apps or navigate anywhere." },
          ],
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) throw new Error(`Model returned HTTP ${response.status}.`);
      const result = await response.json() as {
        usage?: unknown; timings?: unknown;
        choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[];
      };
      console.log(JSON.stringify({
        mode: `${focused ? "focused" : "all"}-${attempt}`,
        tools: tools.length, schemaChars: JSON.stringify(tools).length,
        wallMs: Math.round(performance.now() - started), usage: result.usage, timings: result.timings,
        selected: result.choices?.[0]?.message?.tool_calls?.map((call) => call.function?.name),
      }));
    }
  }
} finally { await connection.close(); }
