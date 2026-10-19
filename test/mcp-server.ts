// Disposable stdio server used only by automated tests. No external accounts.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "sage-test", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => ({
  tools: [{ name: params?.cursor ? "fail" : "echo", description: "Local test tool", inputSchema: {
    type: "object", properties: { text: { type: "string" } }, required: ["text"],
  } }],
  ...(params?.cursor ? {} : { nextCursor: "page-two" }),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [{ type: "text", text: `${params.arguments?.text}; env=${process.env.SAGE_MCP_TEST ?? "missing"}; secret=${process.env.SAGE_MCP_PRIVATE ? "leaked" : "absent"}` }],
  isError: params.name === "fail",
}));
await server.connect(new StdioServerTransport());
