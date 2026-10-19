import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { Bot, Api } from "grammy";
import { Response as TelegramResponse } from "node-fetch";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry, type Conversation, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { context, openAssistant } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";
import { telegramGateway } from "../src/telegram.ts";
import { routinesExtension, Routines, nextRun } from "../extensions/routines.ts";
import { entryText } from "../extensions/recall.ts";
import { redPng } from "./fixtures.ts";
import { tuiAdapter } from "../src/tui-adapter.ts";
import { ScheduledInput, scheduledReply } from "../src/scheduled-delivery.ts";

const png = redPng();
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-media-"));
  const config = { ...readConfig(), dataDir, mcpServers: {}, enableShell: false, telegramToken: "", telegramChat: "",
    searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "", appleId: "", appleAppPassword: "", appleCalendarUrl: "" };
  const faux = fauxProvider({ models: [{ id: "faux-1", input: ["text", "image"] }] });
  const models = createModels(); models.setProvider(faux.provider);
  const open = (sendTelegram?: (text: string, threadId?: number) => Promise<void>) =>
    openAssistant(config, { models, model: { provider: "faux", modelId: "faux-1" }, sendTelegram });
  return { config, faux, open, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}
async function call(faux: ReturnType<typeof fauxProvider>, conversation: Conversation, tool: string, args: JsonObject) {
  faux.setResponses([fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
  assert.equal((await (await conversation.submit({ type: "input", content: "Run this check." }, context)).wait(context)).status, "done");
  const entries = await conversation.entries({}, 20, undefined, context);
  const entry = entries.items.find((e) => e.model?.some((m) => m.role === "toolResult" && m.toolName === tool))!;
  const message = entry.model!.find((m) => m.role === "toolResult")!;
  assert.equal(message.role, "toolResult");
  return { message, text: entryText(entry) };
}

test("Telegram saves owner documents/photos in the original topic, bounds uploads, and excludes voice", async (t) => {
  const f = await fixture();
  const sent: { text: string; thread?: number }[] = [];
  let downloads = 0;
  const bot = new Bot("123456:test-only-token", {
    botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "testbot", can_join_groups: false,
      can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
      has_main_web_app: false, has_topics_enabled: true, allows_users_to_create_topics: true,
      can_manage_bots: false, supports_join_request_queries: false },
    client: { fetch: async (url) => {
      assert.ok(String(url).includes("/file/")); downloads++;
      return new TelegramResponse(String(url).endsWith("photo.jpg") ? png : Buffer.from("Assignment due Friday."));
    } },
  });
  t.mock.method(bot, "start", async () => {});
  t.mock.method(Api.prototype, "sendChatAction", async () => true as const);
  t.mock.method(Api.prototype, "editMessageText", async () => true as const);
  t.mock.method(Api.prototype, "getFile", async (id: string) => ({ file_id: id, file_unique_id: id, file_path: id === "photo" ? "photo.jpg" : "document.txt" }));
  t.mock.method(Api.prototype, "sendMessage", async (...[chat_id, text, options]: Parameters<typeof bot.api.sendMessage>) => {
    sent.push({ text, thread: options?.message_thread_id });
    return { message_id: sent.length, date: 0, chat: { id: Number(chat_id), type: "private", first_name: "Owner" }, text };
  });
  const gateway = telegramGateway({ ...f.config, telegramToken: "test-only", telegramChat: "99" }, bot)!;
  let assistant = await f.open(gateway.send);
  try {
    gateway.start(assistant);
    const incoming = (id: number, media: object, owner = 99) => ({ update_id: id, message: {
      message_id: id, date: 0, message_thread_id: 55, chat: { id: owner, type: "private" as const, first_name: "Owner" },
      from: { id: owner, is_bot: false, first_name: "Owner" }, ...media,
    } });
    const document = { document: { file_id: "doc", file_unique_id: "doc", file_name: "../../assignment.txt", file_size: 22 }, caption: "Read this assignment." };
    await bot.handleUpdate(incoming(1, document, 100));
    assert.equal(downloads, 0);
    f.faux.setResponses([fauxAssistantMessage("Document received.")]);
    await bot.handleUpdate(incoming(2, document));
    const topic = await assistant.telegramConversation(55);
    await topic.waitForIdle(context);
    assert.equal(await readFile(join(assistant.workspace, "uploads/telegram-99-2/assignment.txt"), "utf8"), "Assignment due Friday.");
    await bot.handleUpdate(incoming(2, document));
    assert.equal(downloads, 1);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "uploads/telegram-99-3/photo.jpg" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Photo received."),
    ]);
    await bot.handleUpdate(incoming(3, { photo: [{ file_id: "small", file_unique_id: "small", width: 1, height: 1 },
      { file_id: "photo", file_unique_id: "photo", width: 2, height: 2 }], caption: "Describe this photo." }));
    await topic.waitForIdle(context);
    const transcript = await topic.context(context);
    assert.ok(transcript.messages.some((m) => m.role === "toolResult" && m.content.some((part) => part.type === "image")),
      JSON.stringify(transcript.messages.filter((m) => m.role === "toolResult")));
    assert.ok(!(await assistant.root.context(context)).messages.some((m) => JSON.stringify(m).includes("assignment.txt")));
    const count = f.faux.state.callCount;
    await bot.handleUpdate(incoming(4, { document: { ...document.document, file_size: 21 * 1024 * 1024 } }));
    await bot.handleUpdate(incoming(5, { voice: { file_id: "voice", file_unique_id: "voice", duration: 1 } }));
    assert.equal(f.faux.state.callCount, count);
    assert.equal(downloads, 2);
    assert.ok(sent.every((m) => m.thread === 55));
    assert.ok(sent.some((m) => m.text.includes("too large")));
    await assistant.close(); assistant = await f.open();
    assert.equal((await readFile(join(assistant.workspace, "uploads/telegram-99-3/photo.jpg"))).length, png.length);
  } finally { await gateway.stop(); await assistant.close(); await f.cleanup(); }
});

test("PDF and Word text are read through native tools without accessing external files", async () => {
  const f = await fixture(); const assistant = await f.open();
  try {
    // A minimal real PDF with one text page, generated without a PDF-writing dependency.
    const stream = "BT /F1 12 Tf 20 100 Td (Calculus assignment Friday) Tj ET";
    const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let pdf = "%PDF-1.4\n"; const offsets = [0];
    for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("") +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    await writeFile(join(assistant.workspace, "assignment.pdf"), pdf);
    const extracted = await call(f.faux, assistant.root, "document_read", { path: "assignment.pdf" });
    assert.ok(!extracted.message.isError, extracted.text);
    assert.ok(extracted.text.includes("Calculus assignment Friday"));
    // Use Mammoth's shipped DOCX fixture, so extraction exercises the actual library.
    const fixture = new URL("../node_modules/mammoth/test/test-data/single-paragraph.docx", import.meta.url);
    await writeFile(join(assistant.workspace, "assignment.docx"), await readFile(fixture));
    const word = await call(f.faux, assistant.root, "document_read", { path: "assignment.docx" });
    assert.ok(!word.message.isError, word.text);
    assert.ok(JSON.parse(word.text).text.trim().length > 0);
    const outside = await call(f.faux, assistant.root, "document_read", { path: "../agent.sqlite" });
    assert.ok(outside.message.isError);
  } finally { await assistant.close(); await f.cleanup(); }
});

test("recurrence handles local wall-clock time across daylight saving changes", () => {
  const zone = "America/New_York";
  assert.equal(new Date(nextRun("0 8 * * *", zone, Date.parse("2026-03-07T14:00:00Z"))).toISOString(), "2026-03-08T12:00:00.000Z");
  assert.equal(new Date(nextRun("0 8 * * *", zone, Date.parse("2026-10-31T13:00:00Z"))).toISOString(), "2026-11-01T13:00:00.000Z");
  assert.throws(() => nextRun("* * * * * *", zone, Date.now()));
  assert.throws(() => nextRun("0 8 * * *", "invalid/zone", Date.now()));
});

test("scheduled delivery markers only route a leading directive and preserve legacy defaults", () => {
  assert.deepEqual(scheduledReply("[TUI]\nTerminal update.", true), { channel: "TUI", text: "Terminal update." });
  assert.deepEqual(scheduledReply(" [TELEGRAM]\nPhone update.", false), { channel: "TELEGRAM", text: "Phone update." });
  assert.equal(scheduledReply("[SILENT]", true).channel, "SILENT");
  assert.deepEqual(scheduledReply("Mention [SILENT] in prose.", true), { channel: "TELEGRAM", text: "Mention [SILENT] in prose." });
  assert.equal(scheduledReply("[TUITION]", true).channel, "TELEGRAM");
  assert.equal(scheduledReply("Unmarked update.", false).channel, "TUI");
});

test("recurring runs choose TUI, Telegram, or silence, preserve their topic, and retain an audit transcript", async (t) => {
  let clock = Date.now(); t.mock.method(Date, "now", () => clock);
  const f = await fixture();
  f.config.telegramToken = "test-only";
  const sent: { text: string; thread?: number }[] = [];
  const send = async (text: string, thread?: number) => { sent.push({ text, thread }); };
  let assistant = await f.open(send);
  try {
    const topic = await assistant.telegramConversation(55);
    assert.ok(!(await call(f.faux, topic, "routine", { action: "save", id: "routing", title: "Morning check",
      instructions: "Check the calendar and choose where to report.", cron: "* * * * *" })).message.isError);
    for (const channel of ["TUI", "TELEGRAM", "SILENT"] as const) {
      const previous = (await assistant.harness.snapshot(Routines, context))!.items.routing;
      await assistant.close(); clock = previous.nextAt! + 1;
      const update = channel === "SILENT" ? "[SILENT]" : `[${channel}]\n${channel === "TELEGRAM" ? "**Phone update.**" : "Terminal update."}`;
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("clock", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage(update),
        ...(channel === "TELEGRAM" ? [fauxAssistantMessage("[TELEGRAM]\nPhone update.")] : []),
      ]);
      const before = f.faux.state.callCount;
      assistant = await f.open(send);
      const adapter = await tuiAdapter(assistant, f.config);
      try {
        await adapter.controller.switchConversation(topic.id);
        for (let i = 0; i < 200; i++) {
          if ((await assistant.harness.snapshot(Routines, context))!.items.routing.taskId !== previous.taskId) break;
          await pause(5);
        }
        assert.equal((await assistant.harness.snapshot(Routines, context))!.items.routing.lastStatus, "done");
        assert.equal(f.faux.state.callCount - before, channel === "TELEGRAM" ? 3 : 2, "Only Telegram is rewritten; tools run once");
        const view = adapter.source.current().conversation;
        const visible = view.entries.map(entryText).join("\n");
        assert.ok(visible.includes("Terminal update."));
        assert.ok(!visible.includes("Phone update."));
        assert.ok(!visible.includes("[SILENT]"));
        assert.ok(!view.entries.some(ScheduledInput.is), "Scheduled prompts and tool progress stay out of the TUI");
        const raw = await (await assistant.harness.conversation(topic.id, context))!.entries({}, 100, undefined, context);
        assert.ok(raw.items.some((entry) => ScheduledInput.is(entry) && entry.data?.delivery === "agent"));
        assert.ok(raw.items.map(entryText).some((text) => text.includes(update)));
      } finally { adapter.dispose(); }
    }
    for (let i = 0; i < 100 && sent.length === 0; i++) await pause(5);
    assert.deepEqual(sent, [{ text: "Phone update.", thread: 55 }]);
    f.faux.setResponses([fauxAssistantMessage("Normal terminal reply.")]);
    const topicAgain = (await assistant.harness.conversation(topic.id, context))!;
    await (await assistant.submit("Hello again.", undefined, false, true, topicAgain)).wait(context);
    const adapter = await tuiAdapter(assistant, f.config);
    try {
      await adapter.controller.switchConversation(topic.id);
      assert.ok(adapter.source.current().conversation.entries.map(entryText).join("\n").includes("Normal terminal reply."));
    } finally { adapter.dispose(); }
  } finally { await assistant.close(); await f.cleanup(); }
});

test("an explicit phone update survives admission without a sender and delivers once after restart", async () => {
  const f = await fixture();
  const sent: { text: string; thread?: number }[] = [];
  const send = async (text: string, thread?: number) => { sent.push({ text, thread }); };
  let assistant = await f.open();
  try {
    const topic = await assistant.telegramConversation(66);
    f.faux.setResponses([fauxAssistantMessage("[TELEGRAM]\nYour morning update.")]);
    const submission = await assistant.submit("Scheduled check-in.", "offline-scheduled", true, false, topic, "agent");
    await submission.wait(context);
    let delivery;
    for (let i = 0; i < 100; i++) {
      const graph = await assistant.harness.taskGraph(context);
      delivery = Object.values(graph.value.tasks).find((task) => task.kind === "personal.telegram-delivery");
      graph.dispose();
      if (delivery?.state.status === "running" && delivery.state.phase === "send") break;
      await pause(5);
    }
    assert.ok(delivery, "A durable delivery is created even without a sender");
    const deliveryId = delivery.id;
    await assistant.close();
    assistant = await f.open(send);
    await assistant.harness.waitForTask(deliveryId, context);
    assert.deepEqual(sent, [{ text: "Your morning update.", thread: 66 }]);
    const restoredTopic = await assistant.telegramConversation(66);
    assert.equal((await assistant.submit("Scheduled check-in.", "offline-scheduled", true, false, restoredTopic, "agent")).id, submission.id);
    await assistant.close();
    assistant = await f.open(send);
    assert.equal(sent.length, 1);
  } finally { await assistant.close(); await f.cleanup(); }
});

test("routines survive downtime, repeat once without backlog, preserve topic, and support pause/resume/delete", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sage-routine-"));
  let clock = Date.now(); t.mock.method(Date, "now", () => clock);
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  let harness!: Harness;
  const admitted: { id: string; conversation: number }[] = [];
  const registry = createRegistry();
  registry.install(routinesExtension({ timezone: "America/New_York", submit: async (content, requestId, conversationId) => {
    admitted.push({ id: requestId, conversation: conversationId });
    return (await harness.conversation(conversationId, context))!.submit({ type: "input", content, requestId }, context);
  } }));
  const reopen = async () => harness = await Harness.open(await openNodeSqliteStorage(join(dir, "agent.sqlite")), { models, registry, now: () => clock }, context);
  await reopen();
  try {
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const topic = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
    const created = await call(faux, topic, "routine", { action: "save", id: "morning", title: "Morning check",
      instructions: "Read my calendar and summarize today.", cron: "* * * * *" });
    assert.ok(!created.message.isError, created.text);
    const invalid = await call(faux, root, "routine", { action: "save", id: "morning", cron: "not-a-cron" });
    assert.ok(invalid.message.isError);
    assert.equal((await harness.snapshot(Routines, context))!.items.morning.cron, "* * * * *");
    const updated = await call(faux, root, "routine", { action: "save", id: "morning", title: "Updated morning check" });
    assert.ok(!updated.message.isError);
    const first = (await harness.snapshot(Routines, context))!.items.morning;
    await harness.close(context); clock = first.nextAt! + 180000;
    faux.setResponses([fauxAssistantMessage("Today's update.")]);
    await reopen(); harness.resume();
    for (let i = 0; i < 100; i++) {
      if ((await harness.snapshot(Routines, context))!.items.morning.taskId !== first.taskId) break;
      await pause(5);
    }
    const after = (await harness.snapshot(Routines, context))!.items.morning;
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0].conversation, topic.id);
    assert.ok(after.nextAt! > clock);
    assert.equal(after.lastStatus, "done");
    const handle = (await harness.conversation(root.id, context))!;
    assert.ok(!(await call(faux, handle, "routine", { action: "pause", id: "morning" })).message.isError);
    await harness.close(context); clock = after.nextAt! + 120000;
    await reopen(); harness.resume(); await pause(30);
    assert.equal(admitted.length, 1);
    assert.ok(!(await call(faux, (await harness.conversation(root.id, context))!, "routine", { action: "resume", id: "morning" })).message.isError);
    const resumed = (await harness.snapshot(Routines, context))!.items.morning;
    assert.ok(resumed.nextAt! > clock);
    assert.equal(resumed.conversationId, topic.id);
    await call(faux, (await harness.conversation(root.id, context))!, "routine", { action: "delete", id: "morning" });
    assert.equal((await harness.snapshot(Routines, context))!.items.morning, undefined);
  } finally { await harness.close(context); await rm(dir, { recursive: true, force: true }); }
});
