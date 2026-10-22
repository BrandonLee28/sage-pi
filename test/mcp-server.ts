// Disposable stdio server used only by automated tests. No external accounts.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "sage-test", version: "1" }, { capabilities: { tools: {} } });
const toolName = process.argv[2];
const origin = process.argv[3];
server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => ({
  tools: (toolName === "desktop-fixture" ? ["get_desktop_state", "click", "run_steps"]
    : [toolName ?? (params?.cursor ? "fail" : "echo")]).map((name) => ({ name, description: origin ?? "Local test tool", inputSchema: {
    type: "object", properties: { text: { type: "string" } }, required: ["text"],
  } })),
  ...(toolName || params?.cursor ? {} : { nextCursor: "page-two" }),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [{ type: "text", text: `${params.arguments?.text}; env=${process.env.SAGE_MCP_TEST ?? "missing"}; secret=${process.env.SAGE_MCP_PRIVATE ? "leaked" : "absent"}${origin ? `; origin=${origin}` : ""}` }],
  isError: params.name === "fail",
  ...(toolName === "desktop-fixture" ? { structuredContent: {
    target_id: "live-browser-target", tab_id: "live-tab-capability",
    refs: [{ ref: "snapshot1:2", role: "button", name: "Search flights" }],
  } } : {}),
}));
await server.connect(new StdioServerTransport());
