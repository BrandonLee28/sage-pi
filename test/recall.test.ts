import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, openAssistant, type Assistant } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";
import type { Conversation, JsonObject } from "@earendil-works/pi-durable";
import { entryText } from "../extensions/recall.ts";

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-recall-"));
  const config = { ...readConfig(), dataDir, enableShell: true, telegramToken: "", telegramChat: "",
    searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "", appleId: "", appleAppPassword: "", appleCalendarUrl: "" };
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  const open = () => openAssistant(config, { models, model: { provider: "faux", modelId: "faux-1" } });
  async function call(assistant: Assistant, name: string, args: JsonObject, conversation = assistant.root) {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    const settled = await (await assistant.submit("Run the requested check.", undefined, false, true, conversation)).wait(context);
    assert.equal(settled.status, "done");
    const entries = await conversation.entries({}, 15, undefined, context);
    const entry = entries.items.find((e) => e.model?.some((m) => m.role === "toolResult" && m.toolName === name));
    assert.ok(entry);
    const message = entry.model!.find((m) => m.role === "toolResult")!;
    assert.equal(message.role, "toolResult");
    return { entry, message, text: entryText(entry) };
  }
  return { open, faux, call, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

const seed = (conversation: Conversation, content: string) => conversation.commit((tx) =>
  tx.appendEntry(conversation.id, { kind: "pi.user", model: [{ role: "user", content, timestamp: Date.now() }] }), context);

test("recall finds pre-reset history across topics, paginates, reads sources, and survives restart", async () => {
  const f = await fixture();
  let assistant = await f.open();
  try {
    const old = await seed(assistant.root, "Our calculus assignment uses the silver-orchid dataset.");
    await assistant.root.reset(undefined, context);
    const topic = await assistant.telegramConversation(111);
    const other = await seed(topic, "The silver-orchid assignment is due Friday.");
    const privateThinking = await assistant.root.commit((tx) => tx.appendEntry(assistant.root.id, {
      kind: "pi.assistant", model: [fauxAssistantMessage([
        { type: "thinking", thinking: "hidden-thinking-marker" }, { type: "text", text: "Visible response." },
      ])],
    }), context);
    assert.ok(!entryText(privateThinking).includes("hidden-thinking-marker"));
    assert.ok(!(await assistant.root.context(context)).entries.some((e) => e.id === old.id));
    await assistant.close();
    assistant = await f.open();
    const first = await f.call(assistant, "recall", { action: "search", query: "silver-orchid", limit: 1 });
    assert.ok(!first.message.isError, first.text);
    const page1 = JSON.parse(first.text);
    assert.equal(page1.hits[0].entryId, other.id);
    assert.ok(page1.nextCursor);
    const second = await f.call(assistant, "recall", { action: "search", query: "silver-orchid", limit: 1, cursor: page1.nextCursor });
    assert.equal(JSON.parse(second.text).hits[0].entryId, old.id);
    const opened = await f.call(assistant, "recall", { action: "read", conversationId: assistant.root.id, entryId: old.id });
    assert.ok(JSON.parse(opened.text).entries.some((e: { entryId: number }) => e.entryId === old.id));
    assert.ok(opened.text.includes("calculus"));
    const wrong = await f.call(assistant, "recall", { action: "read", conversationId: topic.id, entryId: old.id });
    assert.ok(wrong.message.isError);
    const badCursor = await f.call(assistant, "recall", { action: "search", query: "different", cursor: page1.nextCursor });
    assert.ok(badCursor.message.isError);
  } finally { await assistant.close(); await f.cleanup(); }
});

test("recall bounds each scan and continues to older matches without skipping history", async () => {
  const f = await fixture();
  const assistant = await f.open();
  try {
    const original = await seed(assistant.root, "ancient-recall-marker");
    await assistant.root.commit(async (tx) => {
      for (let i = 0; i < 2010; i++) await tx.appendEntry(assistant.root.id, {
        kind: "pi.user", model: [{ role: "user", content: `Filler ${i}`, timestamp: Date.now() }],
      });
    }, context);
    const args = { action: "search", query: "ancient-recall-marker", conversationId: assistant.root.id, limit: 15 };
    const first = JSON.parse((await f.call(assistant, "recall", args)).text);
    assert.equal(first.scanned, 2000);
    assert.equal(first.hits.length, 0);
    assert.ok(first.nextCursor);
    const next = JSON.parse((await f.call(assistant, "recall", { ...args, cursor: first.nextCursor })).text);
    assert.equal(next.hits[0].entryId, original.id);
    assert.equal(next.nextCursor, null);
  } finally { await assistant.close(); await f.cleanup(); }
});

test("skills stay user-controlled and complex work has no automatic learning continuation", async () => {
  const f = await fixture();
  const assistant = await f.open();
  try {
    const agent = await assistant.root.agent(context);
    assert.ok(!agent.tools.some((tool) => tool.name === "skill_review"));
    f.faux.setResponses([fauxAssistantMessage("Hi.")]);
    await (await assistant.submit("Hello.")).wait(context);
    assert.equal(f.faux.state.callCount, 1);
    const calls = Array.from({ length: 6 }, () => fauxToolCall("read", { path: "SOUL.md" }));
    f.faux.setResponses([
      fauxAssistantMessage(calls, { stopReason: "toolUse" }),
      fauxAssistantMessage("Work finished."),
    ]);
    await (await assistant.submit("Run a multi-step check.")).wait(context);
    assert.equal(f.faux.state.callCount, 3);
    const view = await assistant.root.context(context);
    assert.ok(!view.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("Brief learning check")));
    assert.ok(JSON.stringify(view.messages).includes("Do not create, edit, or delete skills unless the user explicitly asks."));
  } finally { await assistant.close(); await f.cleanup(); }
});
