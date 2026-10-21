import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc } from "@earendil-works/pi-durable";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { context, openAssistant } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";
import { SpokenPhrases, type VoiceEvent } from "../src/voice.ts";
import { voiceReply } from "../src/voice-reply.ts";
import { tuiAdapter } from "../src/tui-adapter.ts";
import { singleStream } from "../src/model.ts";
import { VoiceMode } from "../extensions/voice.ts";

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await pause(10); }
  assert.fail("Voice check timed out");
}
async function fixture(slow = false) {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-voice-test-"));
  const config = { ...readConfig(), dataDir, mcpServers: {}, enableShell: false,
    telegramToken: "", telegramChat: "", searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "",
    appleId: "", appleAppPassword: "", appleCalendarUrl: "" };
  const faux = fauxProvider(slow ? { tokensPerSecond: 250, tokenSize: { min: 5, max: 5 } } : {});
  const models = createModels(); models.setProvider({ ...faux.provider, ...singleStream(faux.provider) });
  const assistant = await openAssistant(config, { models, model: { provider: "faux", modelId: "faux-1" } });
  return { config, faux, assistant, async close() { await assistant.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test("spoken phrases stream bounded sentences and omit fenced code and Markdown", () => {
  const phrases = new SpokenPhrases();
  assert.deepEqual(phrases.push("Hello **Bran"), []);
  assert.deepEqual(phrases.push("don**. Here is a [link](https://example.com).\n```ts\nsecret();\n```\nDone", true),
    ["Hello Brandon.", "Here is a link.", "Done"]);
  const long = new SpokenPhrases().push("hello ".repeat(150), true);
  assert.ok(long.length > 1);
  assert.ok(long.every((part) => part.length <= 181));
});

test("voice observes native Pi streaming before completion and never speaks thinking", async () => {
  const f = await fixture(true);
  const view = await f.assistant.root.viewState(context);
  const heard: string[] = [];
  let early = false;
  const reply = "Here is the first sentence. " + "This is additional context. ".repeat(16);
  try {
    f.faux.setResponses([fauxAssistantMessage([fauxThinking("PRIVATE REASONING"),
      { type: "text", text: reply }])]);
    await voiceReply(f.assistant, f.assistant.root, "Speak to me.", new AbortController().signal,
      (text) => {
        heard.push(text);
        const generation = view.value.docs["pi.live"]?.generation as { message?: { content: { type: string; text?: string }[] } } | undefined;
        const partial = generation?.message?.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        early ||= Boolean(partial && partial.length < reply.length);
      }, () => {});
    assert.ok(early, "speech should begin before Pi finishes the model response");
    assert.equal(heard[0], "Here is the first sentence.");
    assert.doesNotMatch(heard.join(" "), /PRIVATE REASONING/);
    assert.equal(heard.join(" "), "Here is the first sentence. " + "This is additional context. ".repeat(16).trim());
  } finally { view.dispose(); await f.close(); }
});

test("voice keeps native tools and does not speak their arguments or outputs", async () => {
  const f = await fixture();
  const heard: string[] = [];
  try {
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "test.txt", content: "PRIVATE TOOL ARGUMENT" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The file is saved."),
    ]);
    await voiceReply(f.assistant, f.assistant.root, "Save my file.", new AbortController().signal, (text) => heard.push(text), () => {});
    assert.deepEqual(heard, ["The file is saved."]);
    assert.equal(await readFile(join(f.assistant.workspace, "test.txt"), "utf8"), "PRIVATE TOOL ARGUMENT");
  } finally { await f.close(); }
});

test("hands-free TUI voice interrupts native work, ignores stale transcripts, and restores thinking", async () => {
  const f = await fixture();
  let emit!: (event: VoiceEvent) => void;
  let stops = 0, interrupts = 0, finishes = 0;
  const heard: string[] = [];
  const adapter = await tuiAdapter(f.assistant, f.config, (_config, events) => {
    emit = events;
    return { start: async () => events({ type: "ready" }), stop: () => { stops++; },
      speak: (text) => { heard.push(text); }, interrupt: () => { interrupts++; }, finish: () => { finishes++; } };
  });
  try {
    f.faux.setResponses([fauxAssistantMessage("Hello Brandon.")]);
    await adapter.controller.submit("/speak", "steer");
    assert.equal(f.faux.state.callCount, 0, "the command must not become a user prompt");
    assert.equal((await f.assistant.harness.snapshot(AgentDoc, f.assistant.root.id, context))!.thinkingLevel, "off");
    emit({ type: "speech_start", id: 1 });
    emit({ type: "speech_end", id: 1 });
    emit({ type: "transcript", id: 0, text: "Stale input.", endedAt: Date.now() - 500, asrDoneAt: Date.now() });
    emit({ type: "transcript", id: 1, text: "Hello Sage.", endedAt: Date.now() - 500, asrDoneAt: Date.now() });
    await until(() => finishes === 1);
    assert.deepEqual(heard, ["Hello Brandon."]);
    assert.match(getCurrentSystemPrompt((await f.assistant.root.context(context)).messages), /local terminal voice mode/);
    let started = false;
    f.faux.setResponses([async (_context, options) => {
      started = true;
      await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage("Obsolete reply.");
    }]);
    emit({ type: "speech_start", id: 2 });
    emit({ type: "transcript", id: 2, text: "Another question.", endedAt: Date.now(), asrDoneAt: Date.now() });
    await until(() => started);
    emit({ type: "speech_start", id: 3 });
    await f.assistant.root.waitForIdle(context);
    assert.ok(interrupts >= 3);
    assert.deepEqual(heard, ["Hello Brandon."]);
    await adapter.controller.submit("/speak off", "steer");
    assert.equal(stops, 1);
    assert.equal((await f.assistant.harness.snapshot(AgentDoc, f.assistant.root.id, context))!.thinkingLevel, "low");
    await adapter.controller.submit("/speak", "steer");
    await adapter.controller.newSession();
    assert.equal(stops, 2);
    assert.equal((adapter.source.current().conversation.docs["pi.agent"] as { thinkingLevel: string }).thinkingLevel, "low",
      "new chats must not inherit the temporary voice override");
  } finally { await adapter.dispose(); await f.close(); }
});

test("voice activity detection waits for speech, preserves pre-roll, and bounds utterances", (t) => {
  const result = spawnSync("python3", ["-c", `
import importlib.util
spec = importlib.util.spec_from_file_location("voice_worker", "scripts/voice-worker.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Vad:
    def is_speech(self, frame, rate):
        assert len(frame) == 640 and rate == 16000
        return frame[0] == 1
events = []
detector = module.SpeechDetector(Vad(), lambda *event: events.append(event), 400)
detector.feed(bytes(640 * 30))
assert events == []
detector.feed(bytes([1]) * (640 * 5))
assert events[0][0] == "speech_start"
detector.feed(bytes(640 * 19))
assert len(events) == 1
detector.feed(bytes(640))
assert events[-1][0] == "speech_end"
assert len(events[-1][2][0]) >= 640 * 25
assert len(detector.frames) == 0
detector.feed(bytes([1]) * (640 * 1600))
assert len([event for event in events if event[0] == "speech_end"]) == 2
`], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return t.skip("Optional Python voice runtime is not installed");
  assert.equal(result.status, 0, result.stderr);
});

test("failed voice startup restores thinking and leaves no active microphone session", async () => {
  const f = await fixture();
  let stopped = false;
  const adapter = await tuiAdapter(f.assistant, f.config, () => ({
    start: async () => { throw new Error("Simulated missing speech runtime"); }, stop: () => { stopped = true; },
    speak: () => {}, interrupt: () => {}, finish: () => {},
  }));
  try {
    await adapter.controller.submit("/speak", "steer");
    assert.equal(stopped, true);
    assert.equal(f.faux.state.callCount, 0);
    assert.equal((await f.assistant.harness.snapshot(AgentDoc, f.assistant.root.id, context))!.thinkingLevel, "low");
    assert.match(adapter.source.current().notices.at(-1)!.message, /missing speech runtime/);
  } finally { await adapter.dispose(); await f.close(); }
});

test("reopening Pi restores a voice reasoning override without reopening the microphone", async () => {
  const f = await fixture();
  let reopened: Awaited<ReturnType<typeof openAssistant>> | undefined;
  try {
    await f.assistant.root.configure({ thinkingLevel: "off" }, context);
    await f.assistant.root.commit(async (tx) => { (await tx.doc(VoiceMode, f.assistant.root.id)).previousThinking = "medium"; }, context);
    await f.assistant.close();
    const models = createModels(); models.setProvider(f.faux.provider);
    reopened = await openAssistant(f.config, { models, model: { provider: "faux", modelId: "faux-1" } });
    assert.equal((await reopened.harness.snapshot(AgentDoc, reopened.root.id, context))!.thinkingLevel, "medium");
    assert.equal((await reopened.harness.snapshot(VoiceMode, reopened.root.id, context))!.previousThinking, null);
    assert.equal(f.faux.state.callCount, 0);
  } finally { await reopened?.close(); await f.close(); }
});
