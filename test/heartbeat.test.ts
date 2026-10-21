import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { context, openAssistant } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";
import { singleStream } from "../src/model.ts";
import { Heartbeat, HEARTBEAT_SILENT } from "../extensions/heartbeat.ts";

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 600; i++) {
    if (await predicate()) return;
    await pause(5);
  }
  assert.fail("Timed out waiting for native heartbeat work");
}
async function fixture(enabled = true, intervalMs = 60_000) {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-heartbeat-"));
  const config = { ...readConfig(), dataDir, mcpServers: {}, enableShell: false,
    telegramToken: "", telegramChat: "", searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "",
    appleId: "", appleAppPassword: "", appleCalendarUrl: "" };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider({ ...faux.provider, ...singleStream(faux.provider) });
  const sent: { text: string; thread?: number }[] = [];
  const open = () => openAssistant(config, {
    models, model: { provider: "faux", modelId: "faux-1" },
    sendTelegram: enabled ? async (text, thread) => { sent.push({ text, thread }); } : undefined,
    heartbeatTiming: { intervalMs, quietMs: 100, pollMs: 10 },
  });
  let assistant = await open();
  return { faux, sent, get assistant() { return assistant; },
    async reopen() { await assistant.close(); assistant = await open(); },
    async due() {
      await assistant.harness.commit(async (tx) => {
        const state = await tx.doc(Heartbeat);
        state.nextAt = Date.now() - 100_000;
        state.lastHumanAt = 0;
      }, context);
    },
    state: () => assistant.harness.snapshot(Heartbeat, context),
    async cleanup() { await assistant.close(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

test("heartbeat uses native tools and Telegram style, shares feedback, stays silent, and preserves files on restart", async () => {
  const f = await fixture();
  try {
    const path = join(f.assistant.workspace, "HEARTBEAT.md");
    await writeFile(path, "# Approved work\nWatch the responsibility the user delegated.\n");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "HEARTBEAT.md", content: "# Feedback\nPrefer fewer nudges.\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(HEARTBEAT_SILENT),
    ]);
    await f.due();
    await until(async () => (await f.state())!.nextAt > Date.now());
    await f.assistant.harness.waitForIdle(context);
    assert.deepEqual(f.sent, []);
    assert.equal(await readFile(path, "utf8"), "# Feedback\nPrefer fewer nudges.\n");
    const state = (await f.state())!;
    const heartbeat = (await f.assistant.harness.conversation(state.conversationId!, context))!;
    const prompt = getCurrentSystemPrompt((await heartbeat.context(context)).messages);
    assert.match(prompt, /Ask before adding a new responsibility you propose/);
    assert.match(prompt, /Prefer fewer nudges/);
    assert.match(prompt, /<telegram_reply_style>/);
    await f.reopen();
    assert.equal((await f.state())!.taskId, state.taskId);
    assert.equal((await f.state())!.conversationId, state.conversationId);
    assert.equal(await readFile(path, "utf8"), "# Feedback\nPrefer fewer nudges.\n");
    f.faux.setResponses([fauxAssistantMessage("**A useful update.**"), fauxAssistantMessage("A useful update.")]);
    await f.due();
    await until(() => f.sent.length === 1);
    assert.deepEqual(f.sent, [{ text: "A useful update.", thread: undefined }]);
    const topic = await f.assistant.telegramConversation(25);
    f.faux.setResponses([fauxAssistantMessage("Understood.")]);
    await (await f.assistant.submit("Remember that feedback.", undefined, false, true, topic)).wait(context);
    assert.match(getCurrentSystemPrompt((await topic.context(context)).messages), /Prefer fewer nudges/);
  } finally { await f.cleanup(); }
});

test("human input in another topic interrupts heartbeat inference and resumes only after quiet", async () => {
  const f = await fixture();
  let backgroundActive = false, aborted = false;
  try {
    f.faux.setResponses([
      async (_context, options) => {
        backgroundActive = true;
        await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
        backgroundActive = false;
        return fauxAssistantMessage("Obsolete background reply.");
      },
      () => { assert.equal(backgroundActive, false); return fauxAssistantMessage("Your reply."); },
      fauxAssistantMessage(HEARTBEAT_SILENT),
    ]);
    await f.due();
    await until(() => backgroundActive);
    const topic = await f.assistant.telegramConversation(77);
    await (await f.assistant.submit("Answer me first.", undefined, false, false, topic)).wait(context);
    assert.equal(aborted, true);
    assert.equal(f.faux.state.callCount, 2);
    assert.deepEqual(f.sent, []);
    const state = (await f.state())!;
    assert.equal(state.interrupted, true);
    assert.ok(state.nextAt >= state.lastHumanAt + 100);
    await pause(25);
    assert.equal(f.faux.state.callCount, 2);
    await until(() => f.faux.state.callCount === 3);
    await until(async () => !(await f.state())!.interrupted);
    assert.deepEqual(f.sent, []);
  } finally { await f.cleanup(); }
});

test("heartbeat defers for foreground tools and skips missed intervals", async () => {
  const f = await fixture();
  let toolActive = false, release!: () => void;
  try {
    // Hold a native foreground tool round without occupying inference.
    const { defineExtension, defineTool } = await import("@earendil-works/pi-durable");
    const { Type } = await import("@earendil-works/pi-ai");
    f.assistant.registry.install(defineExtension({ name: "test-hold", tools: [defineTool({
      name: "hold", description: "Hold a simulated foreground tool.", parameters: Type.Object({}), execute: async () => {
        toolActive = true;
        await new Promise<void>((resolve) => { release = resolve; });
        return { output: [{ type: "text", text: "Released" }] };
      },
    })] }));
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Foreground done."), fauxAssistantMessage(HEARTBEAT_SILENT),
    ]);
    const input = await f.assistant.submit("Work on this.");
    await until(() => toolActive);
    await f.due();
    await pause(45);
    assert.equal(f.faux.state.callCount, 1, "heartbeat must not use inference during foreground tools");
    release();
    await input.wait(context);
    await until(() => f.faux.state.callCount === 3);
    await until(async () => (await f.state())!.nextAt > Date.now());
    await pause(45);
    assert.equal(f.faux.state.callCount, 3, "missed intervals must not create a backlog");
  } finally { release?.(); await f.cleanup(); }
});

test("native heartbeat recovery reuses admitted input and does not duplicate delivery", async () => {
  const f = await fixture();
  let started = false;
  try {
    f.faux.setResponses([
      async (_context, options) => {
        started = true;
        await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return fauxAssistantMessage("Interrupted by shutdown.");
      },
      fauxAssistantMessage("Recovered useful update."),
    ]);
    await f.due();
    await until(() => started);
    const state = (await f.state())!;
    await f.reopen();
    await until(() => f.sent.length === 1);
    await until(async () => (await f.state())!.nextAt > Date.now());
    const heartbeat = (await f.assistant.harness.conversation(state.conversationId!, context))!;
    const entries = await heartbeat.entries({}, 100, undefined, context);
    assert.equal(entries.items.filter((e) => e.kind === "personal.scheduled").length, 1);
    await f.reopen();
    await pause(40);
    assert.deepEqual(f.sent, [{ text: "Recovered useful update.", thread: undefined }]);
  } finally { await f.cleanup(); }
});

test("heartbeat performs no inference without Telegram transport", async () => {
  const f = await fixture(false);
  try {
    await f.due();
    await pause(45);
    assert.equal(f.faux.state.callCount, 0);
    assert.deepEqual(f.sent, []);
  } finally { await f.cleanup(); }
});

test("heartbeat waits for inactivity, repeats after its interval, and never reports empty or failed checks", async () => {
  const f = await fixture(true, 150);
  try {
    f.faux.setResponses([
      fauxAssistantMessage(""),
      fauxAssistantMessage("Failure", { stopReason: "error", errorMessage: "Simulated model failure" }),
      fauxAssistantMessage(HEARTBEAT_SILENT),
    ]);
    await f.assistant.noteHumanActivity();
    await f.assistant.harness.commit(async (tx) => { (await tx.doc(Heartbeat)).nextAt = 0; }, context);
    await pause(30);
    assert.equal(f.faux.state.callCount, 0);
    await until(() => f.faux.state.callCount === 1);
    await until(async () => (await f.state())!.nextAt > Date.now());
    await pause(40);
    assert.equal(f.faux.state.callCount, 1);
    await until(() => f.faux.state.callCount >= 2);
    await until(() => f.faux.state.callCount >= 3);
    await f.assistant.harness.waitForIdle(context);
    assert.deepEqual(f.sent, []);
  } finally { await f.cleanup(); }
});
