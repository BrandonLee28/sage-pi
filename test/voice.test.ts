import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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
import { localVoice, SpokenPhrases, type VoiceEvent } from "../src/voice.ts";
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
  assert.deepEqual(phrases.push("Hello **the"), []);
  assert.deepEqual(phrases.push("re**. Here is a [link](https://example.com).\n```ts\nsecret();\n```\nDone", true),
    ["Hello there.", "Here is a link.", "Done"]);
  const long = new SpokenPhrases().push("hello ".repeat(150), true);
  assert.ok(long.length > 1);
  assert.ok(long.every((part) => part.length <= 181));
});

test("native audio bridge waits for playback completion and ignores canceled audio", async (t) => {
  if (process.platform !== "darwin") return t.skip("Local voice is macOS-only");
  const directory = await mkdtemp(join(tmpdir(), "sage-voice-pipes-"));
  const keys = ["VOICE_PYTHON", "VOICE_AUDIO", "VOICE_DATA_DIR"];
  const previous = keys.map((key) => process.env[key]);
  const events: VoiceEvent[] = [];
  let engine: ReturnType<typeof localVoice> | undefined;
  try {
    const worker = join(directory, "worker");
    const device = join(directory, "audio");
    await writeFile(worker, `#!/usr/bin/env node
const {createInterface}=require('node:readline');
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
send({type:'ready'});
createInterface({input:process.stdin}).on('line',line=>{
 const job=JSON.parse(line);
 if(job.type==='mic') send({type:'calibrated',value:-40});
 if(job.type==='speak') {
  send({type:'audio',epoch:job.epoch,sampleRate:24000,pcm:'AAAAAA=='});
  send({type:'audio_end',epoch:job.epoch});
 }
});
`, { mode: 0o700 });
    await writeFile(device, `#!/usr/bin/env node
const {createInterface}=require('node:readline');
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
send({type:'ready'}); send({type:'mic',pcm:'AAAAAA=='});
createInterface({input:process.stdin}).on('line',line=>{
 const job=JSON.parse(line);
 // Emit even canceled epochs to exercise the application's late-event guard.
 if(job.type==='audio_end') setTimeout(()=>send(job),200);
});
`, { mode: 0o700 });
    process.env.VOICE_PYTHON = worker; process.env.VOICE_AUDIO = device; process.env.VOICE_DATA_DIR = directory;
    engine = localVoice({ ...readConfig(), dataDir: directory }, (event) => events.push(event));
    await engine.start();
    await until(() => events.some((event) => event.type === "calibrated"));
    engine.speak("Hello.");
    await until(() => events.some((event) => event.type === "audio"));
    assert.ok(!events.some((event) => event.type === "audio_end"), "synthesis completion must not masquerade as playback completion");
    engine.interrupt();
    await pause(250);
    assert.ok(!events.some((event) => event.type === "audio_end"), "late canceled playback must not reset a newer turn");
    engine.speak("A new reply.");
    await until(() => events.some((event) => event.type === "audio_end" && event.epoch === 1));
    assert.ok(!events.some((event) => event.type === "error"), JSON.stringify(events));
  } finally {
    engine?.stop();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await rm(directory, { recursive: true, force: true });
  }
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

test("voice selects spoken instructions while preserving shared values, edits, and text conversations", async () => {
  const f = await fixture();
  const soul = "Shared warmth and trust.\n<text_style>VISUAL_PERSONALITY_ONLY</text_style>\nKeep the user's chosen goals.";
  await writeFile(join(f.assistant.workspace, "SOUL.md"), soul);
  const adapter = await tuiAdapter(f.assistant, f.config, () => ({
    start: async () => {}, stop() {}, speak() {}, finish() {}, interrupt() {},
  }));
  const promptFor = async (conversation = f.assistant.root) => {
    let prompt = "";
    f.faux.setResponses([async (input) => {
      prompt = getCurrentSystemPrompt(input.messages);
      return fauxAssistantMessage("Hello.");
    }]);
    await (await f.assistant.submit("Hello.", undefined, false, true, conversation)).wait(context);
    return prompt;
  };
  try {
    await adapter.controller.submit("/speak", "steer");
    const spoken = await promptFor();
    assert.match(spoken, /Shared warmth and trust/);
    assert.match(spoken, /Keep the user's chosen goals/);
    assert.match(spoken, /quick live exchange/);
    assert.doesNotMatch(spoken, /VISUAL_PERSONALITY_ONLY/);
    const other = await f.assistant.createSession(f.assistant.root.id);
    const text = await promptFor(other);
    assert.match(text, /VISUAL_PERSONALITY_ONLY/);
    assert.doesNotMatch(text, /quick live exchange/);
    await writeFile(join(f.assistant.workspace, "VOICE.md"), "SPOKEN_LIVE_EDIT");
    assert.match(await promptFor(), /SPOKEN_LIVE_EDIT/);
    await adapter.controller.submit("/speak off", "steer");
    const restored = await promptFor();
    assert.match(restored, /VISUAL_PERSONALITY_ONLY/);
    assert.doesNotMatch(restored, /SPOKEN_LIVE_EDIT/);
    assert.equal(await readFile(join(f.assistant.workspace, "SOUL.md"), "utf8"), soul);
  } finally { await adapter.dispose(); await f.close(); }
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
    f.faux.setResponses([fauxAssistantMessage("Hello there.")]);
    await adapter.controller.submit("/speak", "steer");
    assert.equal(adapter.source.current().voice?.phase, "calibrating");
    emit({ type: "calibrating", value: .5 });
    assert.equal(adapter.source.current().voice?.progress, .5);
    emit({ type: "calibrated", value: -40 });
    emit({ type: "level", value: .7 });
    assert.equal(adapter.source.current().voice?.phase, "listening");
    assert.equal(adapter.source.current().voice?.level, .7);
    assert.equal(f.faux.state.callCount, 0, "the command must not become a user prompt");
    assert.equal((await f.assistant.harness.snapshot(AgentDoc, f.assistant.root.id, context))!.thinkingLevel, "off");
    emit({ type: "speech_start", id: 1 });
    assert.equal(adapter.source.current().voice?.phase, "hearing");
    emit({ type: "speech_end", id: 1 });
    emit({ type: "transcript", id: 0, text: "Stale input.", endedAt: Date.now() - 500, asrDoneAt: Date.now() });
    emit({ type: "transcript", id: 1, text: "Hello Sage.", endedAt: Date.now() - 500, asrDoneAt: Date.now() });
    await until(() => finishes === 1);
    assert.deepEqual(heard, ["Hello there."]);
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
    assert.deepEqual(heard, ["Hello there."]);
    await adapter.controller.submit("/speak off", "steer");
    assert.equal(adapter.source.current().voice, undefined);
    assert.equal(stops, 1);
    assert.equal((await f.assistant.harness.snapshot(AgentDoc, f.assistant.root.id, context))!.thinkingLevel, "low");
    await adapter.controller.submit("/speak", "steer");
    await adapter.controller.newSession();
    assert.equal(stops, 2);
    assert.equal((adapter.source.current().conversation.docs["pi.agent"] as { thinkingLevel: string }).thinkingLevel, "low",
      "new chats must not inherit the temporary voice override");
  } finally { await adapter.dispose(); await f.close(); }
});

test("voice calibrates room noise, ignores brief/quiet sounds, and bounds speech", (t) => {
  const result = spawnSync("python3", ["-c", `
import importlib.util
import struct
spec = importlib.util.spec_from_file_location("voice_worker", "scripts/voice-worker.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Vad:
    def is_speech(self, frame, rate):
        assert len(frame) == 640 and rate == 16000
        return any(frame)
events = []
detector = module.SpeechDetector(Vad(), lambda *event: events.append(event), 400)
noise = struct.pack('<320h', *([100] * 320))
voice = struct.pack('<320h', *([3000] * 320))
speech = lambda: [event for event in events if event[0].startswith('speech_')]
detector.feed(noise * 99)
assert detector.threshold_db is None and speech() == []
detector.feed(noise)
assert detector.threshold_db is not None
assert events[-1][0] == 'calibrated'
# A VAD false positive at the calibrated room level must not start speech.
detector.feed(noise * 100)
assert speech() == []
# A keyboard-like burst shorter than 160 ms must not interrupt anything.
detector.feed(voice * 5 + noise * 30)
assert speech() == []
detector.feed(voice * 8 + noise * 20)
assert [event[0] for event in speech()] == ['speech_start', 'speech_discarded']
events.clear()
detector.feed(voice * 20 + noise * 19)
assert [event[0] for event in speech()] == ['speech_start']
detector.feed(noise)
assert speech()[-1][0] == "speech_end"
assert len(speech()[-1][2][0]) >= 640 * 40
assert len(detector.frames) == 0
detector.feed(voice * 1600)
assert len([event for event in speech() if event[0] == "speech_end"]) == 2
# Each new microphone session starts uncalibrated again.
assert module.SpeechDetector(Vad(), lambda *event: None).threshold_db is None
`], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return t.skip("Optional Python voice runtime is not installed");
  assert.equal(result.status, 0, result.stderr);
});

test("Parakeet decodes each complete utterance in a fresh 16 kHz stream", (t) => {
  const result = spawnSync("python3", ["-c", `
import importlib.util
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("voice_worker", "scripts/voice-worker.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
streams = []
class Stream:
    def accept_waveform(self, rate, samples):
        assert rate == 16000
        self.samples = samples
class Recognizer:
    def create_stream(self):
        stream = Stream()
        streams.append(stream)
        return stream
    def decode_stream(self, stream):
        assert stream is streams[-1]
        stream.result = SimpleNamespace(text=" Hello Sage. " if any(stream.samples) else " ")
asr = Recognizer()
assert module.transcribe(asr, [0.25, -0.25]) == "Hello Sage."
assert module.transcribe(asr, [0.0, 0.0]) == ""
assert len(streams) == 2 and streams[0] is not streams[1]
assert streams[0].samples == [0.25, -0.25] and streams[1].samples == [0.0, 0.0]
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
