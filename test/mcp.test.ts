import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

test("isolated assistant tests do not launch MCP servers from configured settings", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-mcp-isolation-"));
  const marker = join(dataDir, "unexpected-server-launch");
  try {
    await writeFile(join(dataDir, "settings.json"), JSON.stringify({ mcpServers: {
      isolation_probe: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`] },
    } }));
    const coreTest = fileURLToPath(new URL("./core.test.ts", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=upstream TUI adapter", coreTest], {
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, DATA_DIR: dataDir, TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" }, timeout: 15000,
    });
    assert.match(stdout, /pass 1\b/);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("all Cua tools are discovered on demand through native Pi", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-cua-discovery-"));
  const config = { ...readConfig(), dataDir, enableShell: false, telegramToken: "", telegramChat: "",
    searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "", appleId: "", appleAppPassword: "", appleCalendarUrl: "",
    mcpServers: { desktop: { command: process.execPath,
      args: [fileURLToPath(new URL("./mcp-server.ts", import.meta.url)), "desktop-fixture"] } },
  };
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  const open = () => openAssistant(config, { models, model: { provider: "faux", modelId: "faux-1" } });
  let assistant = await open();
  try {
    let agent = await assistant.root.agent(context);
    assert.ok(!agent.tools.some((tool) => tool.name.startsWith("mcp__desktop__")));
    assert.ok(agent.deferred.some((tool) => tool.name === "mcp__desktop__get_desktop_state"));
    assert.ok(agent.tools.some((tool) => tool.name === "tool_search"));
    assert.ok(!agent.tools.some((tool) => tool.name === "mcp__desktop__click"));
    assert.ok(agent.deferred.some((tool) => tool.name === "mcp__desktop__click"));
    assert.equal(assistant.registry.snapshot().tools().find(({ tool }) => tool.name === "mcp__desktop__click")?.tool.replay, "unsafe");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "mcp__desktop__click", limit: 1 }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("mcp__desktop__click", { text: "mock action" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    assert.equal((await (await assistant.submit("Use the mock desktop click.")).wait(context)).status, "done");
    const messages = (await assistant.root.context(context)).messages;
    assert.ok(messages.some((message) => message.role === "toolResult" && message.toolName === "mcp__desktop__click" && !message.isError));
    assert.match(JSON.stringify(messages), /live-browser-target/);
    assert.match(JSON.stringify(messages), /live-tab-capability/);
    assert.match(JSON.stringify(messages), /snapshot1:2/);
    assert.match(JSON.stringify(messages), /snapshot_format=semantic_v2/);
    assert.match(JSON.stringify(messages), /Cua browser tools are still computer use/);
    await assistant.close(); assistant = await open();
    agent = await assistant.root.agent(context);
    assert.ok(agent.tools.some((tool) => tool.name === "mcp__desktop__click"), "loaded tools survive restart");
    assert.ok(agent.deferred.some((tool) => tool.name === "mcp__desktop__run_steps"), "unused tools stay deferred");
  } finally { await assistant.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("colliding MCP servers cannot shadow installed tools or partially install their tools", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-mcp-collision-"));
  const server = fileURLToPath(new URL("./mcp-server.ts", import.meta.url));
  const config = { ...readConfig(), dataDir, enableShell: false, telegramToken: "", telegramChat: "",
    searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "", appleId: "", appleAppPassword: "", appleCalendarUrl: "",
    mcpServers: {
      a: { command: process.execPath, args: [server, "b__echo", "first server"] },
      a__b: { command: process.execPath, args: [server, "echo", "second server"] },
      unrelated: { command: process.execPath, args: [server, "echo", "unrelated server"] },
    },
  };
  const diagnostics: string[] = [];
  t.mock.method(console, "error", (message: unknown) => { diagnostics.push(String(message)); });
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  const assistant = await openAssistant(config, { models, model: { provider: "faux", modelId: "faux-1" } });
  try {
    const tools = assistant.registry.snapshot().tools();
    assert.equal(tools.filter(({ tool }) => tool.name === "mcp__a__b__echo").length, 1);
    assert.ok(tools.some(({ tool }) => tool.name === "mcp__unrelated__echo"));
    assert.ok(!assistant.registry.snapshot().installed().some((extension) => extension.name === "mcp:a__b"));
    assert.match(diagnostics.join("\n"), /a__b skipped: tool mcp__a__b__echo is already registered/);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp__a__b__echo", { text: "hello" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    await (await assistant.submit("Call the first server.")).wait(context);
    const transcript = JSON.stringify((await assistant.root.context(context)).messages);
    assert.match(transcript, /origin=first server/);
    assert.doesNotMatch(transcript, /origin=second server/);
  } finally { await assistant.close(); await rm(dataDir, { recursive: true, force: true }); }
});

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
