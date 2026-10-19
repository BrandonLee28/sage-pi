import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openAssistant, context } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";
import { telegramProgress } from "../src/telegram-progress.ts";

test("Telegram progress reflects native work, elapsed inactivity, completion, and never exposes source contents", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-progress-"));
  const config = { ...readConfig(), dataDir, enableShell: false, telegramToken: "", telegramChat: "",
    appleId: "", appleAppPassword: "", appleCalendarUrl: "", searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "" };
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  const assistant = await openAssistant(config, { models, model: { provider: "faux", modelId: "faux-1" } });
  const bot = new Bot("123456:test-only", { client: { fetch: async () => { throw new Error("No network allowed"); } } });
  const sent: string[] = [], edits: string[] = [];
  t.mock.method(bot.api, "sendMessage", async (...[chat, text, options]: Parameters<typeof bot.api.sendMessage>) => {
    assert.equal(chat, "99"); assert.equal(options?.message_thread_id, 333); assert.equal(options?.disable_notification, true);
    sent.push(text);
    return { message_id: 600, date: 0, chat: { id: 99, type: "private", first_name: "Owner" }, text };
  });
  t.mock.method(bot.api, "editMessageText", async (...[chat, id, text]: Parameters<typeof bot.api.editMessageText>) => {
    assert.equal(chat, "99"); assert.equal(id, 600); assert.equal(typeof text, "string"); edits.push(String(text)); return true as const;
  });
  let beginTool!: () => void, releaseTool!: () => void, beginAnswer!: () => void, releaseAnswer!: () => void;
  const toolStarted = new Promise<void>((r) => { beginTool = r; });
  const toolWaiting = new Promise<void>((r) => { releaseTool = r; });
  const answerStarted = new Promise<void>((r) => { beginAnswer = r; });
  const answerWaiting = new Promise<void>((r) => { releaseAnswer = r; });
  assistant.registry.install(defineExtension({ name: "test-progress", tools: [defineTool({
    name: "calendar_write", parameters: Type.Object({ title: Type.String() }), description: "Simulated work only.",
    execute: async () => { beginTool(); await toolWaiting; return { output: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }] }; },
  })] }));
  const topic = await assistant.telegramConversation(333);
  const progress = telegramProgress(bot, "99", topic, 333);
  try {
    // Start the monitor before submitting, as the gateway does.
    await progress.update();
    faux.setResponses([
      fauxAssistantMessage([{ type: "thinking", thinking: "PRIVATE_REASONING" },
        fauxToolCall("calendar_write", { title: "PRIVATE_TITLE" })], { stopReason: "toolUse" }),
      async () => { beginAnswer(); await answerWaiting; return fauxAssistantMessage("Finished."); },
    ]);
    const submission = await assistant.submit("Make the requested change.", undefined, false, true, topic);
    await toolStarted; await progress.update();
    assert.ok(edits.at(-1)?.includes("Updating calendar"));
    const now = Date.now(); t.mock.method(Date, "now", () => now + 30000);
    await progress.update();
    assert.ok(edits.at(-1)?.includes("No new model/tool activity for 30s"));
    releaseTool(); await answerStarted; await progress.update();
    assert.ok(edits.at(-1)?.includes("Waiting for model"));
    assert.ok(edits.at(-1)?.includes("1 tool call finished"));
    releaseAnswer(); await submission.wait(context); await progress.stop();
    assert.equal(sent.length, 1);
    assert.ok(edits.at(-1)?.includes("Reply ready"));
    assert.ok(![...sent, ...edits].some((text) => text.includes("PRIVATE_")));
    const count = edits.length; await progress.update(); assert.equal(edits.length, count);

    // An unavailable status API never prevents a normal model response or leaks a watcher.
    t.mock.method(bot.api, "sendMessage", async () => { throw new Error("Simulated status failure"); });
    const unavailable = telegramProgress(bot, "99", topic, 333);
    faux.setResponses([fauxAssistantMessage("Normal response still works.")]);
    assert.equal((await (await assistant.submit("Hello.", undefined, false, true, topic)).wait(context)).status, "done");
    await unavailable.update(); await unavailable.stop("Stopped");
  } finally {
    releaseTool(); releaseAnswer(); await progress.stop("Gateway stopped");
    await assistant.close(); await rm(dataDir, { recursive: true, force: true });
  }
});
