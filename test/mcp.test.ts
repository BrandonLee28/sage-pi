import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectMcp } from "../extensions/mcp.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { AgentDoc } from "@earendil-works/pi-durable";
import { context, openAssistant } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";

test("MCP tools use Pi's native validation/execution and close on shutdown", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-mcp-"));
  process.env.SAGE_MCP_TEST = "allowed";
  process.env.SAGE_MCP_PRIVATE = "private-test-value";
  const config = { ...readConfig(), dataDir, enableShell: false, telegramToken: "", telegramChat: "",
    searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "", appleId: "", appleAppPassword: "", appleCalendarUrl: "",
    mcpServers: { mock: { command: process.execPath, args: [fileURLToPath(new URL("./mcp-server.ts", import.meta.url))], env: ["SAGE_MCP_TEST"] } },
  };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const assistant = await openAssistant(config, { models, model: { provider: "faux", modelId: "faux-1" } });
  try {
    assert.equal(assistant.registry.snapshot().tools().find(({ tool }) => tool.name === "mcp__mock__echo")?.tool.replay, "unsafe");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp__mock__echo", { text: "hello" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
      fauxAssistantMessage(fauxToolCall("mcp__mock__fail", { text: "failure" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Failed as expected."),
      fauxAssistantMessage(fauxToolCall("mcp__mock__echo", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Invalid arguments rejected."),
    ]);
    await (await assistant.submit("Echo")).wait(context);
    const transcript = await assistant.root.context(context);
    assert.ok(getCurrentTools(transcript.messages).some((tool) => tool.name === "mcp__mock__echo"));
    assert.match(JSON.stringify(transcript.messages), /hello; env=allowed; secret=absent/);
    await (await assistant.submit("Fail")).wait(context);
    const failed = (await assistant.root.context(context)).messages.find((message) => message.role === "toolResult" && message.toolName === "mcp__mock__fail");
    assert.ok(failed && failed.role === "toolResult" && failed.isError);
    await (await assistant.submit("Invalid call")).wait(context);
    const invalid = (await assistant.root.context(context)).messages.filter((message) => message.role === "toolResult" && message.toolName === "mcp__mock__echo").at(-1);
    assert.ok(invalid && invalid.role === "toolResult" && invalid.isError);
    assert.doesNotMatch(JSON.stringify(invalid), /undefined; env=/);
  } finally {
    await assistant.close();
    delete process.env.SAGE_MCP_TEST;
    delete process.env.SAGE_MCP_PRIVATE;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("HTTP MCP uses a named bearer token and lists tools without invoking them", async () => {
  const mcp = new Server({ name: "http-test", version: "1" }, { capabilities: { tools: {} } });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  await mcp.connect(transport);
  const headers: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    headers.push(request.headers.authorization);
    void transport.handleRequest(request, response);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.SAGE_MCP_HTTP_TEST = "local-test-token";
  try {
    const connection = await connectMcp("http", { url: `http://127.0.0.1:${address.port}/mcp`, bearerTokenEnv: "SAGE_MCP_HTTP_TEST" }, tmpdir());
    await connection.close();
    assert.ok(headers.length >= 2);
    assert.ok(headers.every((header) => header === "Bearer local-test-token"));
    await assert.rejects(connectMcp("http", { url: `http://127.0.0.1:${address.port}`, bearerTokenEnv: "SAGE_MCP_MISSING" }, tmpdir()), /Set SAGE_MCP_MISSING/);
  } finally {
    delete process.env.SAGE_MCP_HTTP_TEST;
    await mcp.close();
    server.close();
    server.closeAllConnections();
  }
});

test("CLI model revisions update existing conversations once and preserve later TUI choices", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-model-choice-"));
  const config = { ...readConfig(), dataDir, modelRevision: "choice-one", mcpServers: {}, enableShell: false,
    telegramToken: "", telegramChat: "", searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "", appleId: "", appleAppPassword: "", appleCalendarUrl: "" };
  const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const first = { provider: "faux", modelId: "faux-1" };
  const second = { provider: "faux", modelId: "faux-2" };
  const open = (model = first) => openAssistant(config, { models, model });
  let assistant = await open();
  try {
    const topic = await assistant.telegramConversation(12);
    await assistant.root.configure({ model: second }, context);
    await topic.configure({ model: second }, context);
    await assistant.close();
    assistant = await open();
    assert.deepEqual((await assistant.harness.snapshot(AgentDoc, assistant.root.id, context))?.model, second);
    config.modelRevision = "choice-two";
    await assistant.close();
    assistant = await open();
    assert.deepEqual((await assistant.harness.snapshot(AgentDoc, assistant.root.id, context))?.model, first);
    assert.deepEqual((await assistant.harness.snapshot(AgentDoc, topic.id, context))?.model, first);
  } finally { await assistant.close(); await rm(dataDir, { recursive: true, force: true }); }
});
