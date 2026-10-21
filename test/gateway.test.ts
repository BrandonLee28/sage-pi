import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, LiveDoc } from "@earendil-works/pi-durable";
import { openAssistant, context } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";
import { openGateway, voiceEvent } from "../src/gateway.ts";
import { connectGateway } from "../src/gateway-client.ts";
import type { VoiceEvent } from "../src/voice.ts";
import { gatewayUrl, readSettings, saveSettings } from "../src/settings.ts";

const token = "disposable-gateway-test-token-00000000";
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await pause(10); }
  assert.fail("Gateway check timed out");
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sage-gateway-"));
  const config = { ...readConfig(), dataDir: join(directory, "server"), mcpServers: {}, enableShell: false,
    telegramToken: "", telegramChat: "", searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "",
    appleId: "", appleAppPassword: "", appleCalendarUrl: "" };
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const open = () => openAssistant(config, { models, model: { provider: "faux", modelId: "faux-1" } });
  const assistant = await open();
  const gateway = await openGateway(assistant, config, { token, port: 0 });
  const address = gateway.server.address(); assert.ok(address && typeof address === "object");
  return { directory, config, faux, assistant, gateway, open, url: `http://127.0.0.1:${address.port}`,
    async close() { await gateway.close(); await assistant.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("CLI prompts once, saves an authenticated connection privately, reconnects without exports, and forgets it", async () => {
  const f = await fixture();
  const directory = join(f.directory, "mac-client");
  const preload = join(f.directory, "terminal.mjs");
  await writeFile(preload, `
process.stdin.isTTY = true;
process.stdin.setRawMode = () => {};
process.stdout.isTTY = true;
process.stdout.columns = 80;
process.stdout.rows = 24;
`);
  const cli = fileURLToPath(new URL("../bin/sage.mjs", import.meta.url));
  const run = (args: string[], prompt: boolean, overrideToken = "") => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", preload, cli, ...args], { env: {
      ...process.env, CLIENT_DATA_DIR: directory, DATA_DIR: join(f.directory, "unused-server"),
      GATEWAY_URL: "", GATEWAY_TOKEN: overrideToken, TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "",
    } });
    let output = "", errors = "", sent = false, urlSent = false, exited = false;
    const timeout = setTimeout(() => { child.kill(); reject(new Error("CLI connection test timed out")); }, 10000);
    child.stdout.on("data", (data) => {
      output += data;
      if (prompt && !urlSent && /Gateway URL/.test(output)) { urlSent = true; child.stdin.write(f.url + "\r"); }
      if (prompt && !sent && /Gateway token/.test(output)) { sent = true; child.stdin.write(token + "\r"); }
      if (!exited && /Ask Sage anything/.test(output)) { exited = true; child.stdin.write("\x04"); }
    });
    child.stderr.on("data", (data) => { errors += data; });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`CLI exited ${code}: ${errors}`));
      else resolve(output);
    });
  });
  try {
    const first = await run([], true);
    assert.doesNotMatch(first, new RegExp(token));
    assert.deepEqual(readSettings(directory).gateway, { url: f.url, token });
    assert.equal((await stat(join(directory, "settings.json"))).mode & 0o777, 0o600);
    const second = await run([], false);
    assert.doesNotMatch(second, /Gateway token/);
    await assert.rejects(run(["connect", f.url], false, "disposable-wrong-gateway-token-000000"), /401/);
    assert.deepEqual(readSettings(directory).gateway, { url: f.url, token });
    assert.equal(f.faux.state.callCount, 0);
    await assert.rejects(access(join(directory, "agent.sqlite")), { code: "ENOENT" });
    await assert.rejects(access(join(directory, "workspace")), { code: "ENOENT" });
    await assert.rejects(access(join(f.directory, "unused-server")), { code: "ENOENT" });
    const before = readSettings(directory);
    await saveSettings(directory, { ...before, mcpServers: {} });
    await run(["connect", "--forget"], false);
    assert.equal(readSettings(directory).gateway, undefined);
    assert.deepEqual(readSettings(directory).mcpServers, {});
    assert.throws(() => gatewayUrl("http://example.invalid/other?token=secret"), /origin/);
    assert.throws(() => gatewayUrl("http://user:password@example.invalid"), /credentials/);
  } finally { await f.close(); }
});

test("private gateway validates callers and commands, preserves native sessions, and never opens client storage", async () => {
  const f = await fixture();
  let remote: Awaited<ReturnType<typeof connectGateway>> | undefined;
  try {
    await assert.rejects(openGateway(f.assistant, f.config, { token: "short", port: 0 }), /at least 32/);
    assert.equal((await fetch(f.url + "/health")).status, 200);
    assert.equal((await fetch(f.url + "/v1/attach")).status, 401);
    assert.equal((await fetch(f.url + "/v1/attach?token=" + token)).status, 401);
    await assert.rejects(connectGateway(f.url, "wrong", f.directory), /401/);
    assert.equal((await fetch(f.url + "/v1/attach", { headers: { Authorization: `Bearer ${token}`, Origin: "http://evil.invalid" } })).status, 403);
    remote = await connectGateway(f.url, token, join(f.directory, "client"));
    assert.equal(remote.source.current().conversation.conversation.id, f.assistant.root.id);
    await assert.rejects(connectGateway(f.url, token, f.directory), /409/);
    assert.equal((await fetch(f.url + "/v1/command", { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status, 409);
    f.faux.setResponses([fauxAssistantMessage("Saved on the gateway.")]);
    await remote.controller.submit("A remote prompt.", "steer");
    await until(() => JSON.stringify(remote!.source.current().conversation.entries).includes("Saved on the gateway."));
    const inspector = await remote.controller.inspect("memory");
    assert.equal(inspector?.title, "Memory");
    await remote.controller.cycleThinking();
    assert.equal((await f.assistant.harness.snapshot(AgentDoc, f.assistant.root.id, context))!.thinkingLevel, "off");
    await remote.controller.newSession();
    const sessionId = remote.source.current().conversation.conversation.id;
    assert.notEqual(sessionId, f.assistant.root.id);
    await remote.controller.switchConversation(f.assistant.root.id);
    await remote.controller.switchConversation(sessionId);
    // The command is refused at the transport boundary before any model call.
    const calls = f.faux.state.callCount;
    await remote.controller.submit("x".repeat(65537), "steer");
    assert.match(remote.source.current().notices.at(-1)!.message, /400/);
    assert.equal(f.faux.state.callCount, calls);
    await remote.dispose(); remote = undefined;
    remote = await connectGateway(f.url, token, join(f.directory, "client"));
    assert.equal(remote.source.current().conversation.conversation.id, sessionId);
    await assert.rejects(access(join(f.directory, "client", "agent.sqlite")), { code: "ENOENT" });
    await assert.rejects(access(join(f.directory, "client", "workspace")), { code: "ENOENT" });
  } finally { await remote?.dispose(); await f.close(); }
});

test("disconnect leaves native text work running; a gateway restart restores the same transcript", async () => {
  const f = await fixture();
  let remote = await connectGateway(f.url, token, f.directory);
  let finish!: () => void, started = false, aborted = false;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  f.faux.setResponses([async (_context, options) => {
    started = true;
    options?.signal?.addEventListener("abort", () => { aborted = true; finish(); }, { once: true });
    await gate;
    return fauxAssistantMessage("Completed while the Mac was away.");
  }]);
  try {
    await remote.controller.submit("Keep working after disconnect.", "steer");
    await until(() => started);
    await remote.dispose();
    assert.equal(aborted, false);
    finish();
    await f.assistant.root.waitForIdle(context);
    await f.gateway.close(); await f.assistant.close();
    const reopened = await f.open();
    const gateway = await openGateway(reopened, f.config, { token, port: 0 });
    try {
      const address = gateway.server.address(); assert.ok(address && typeof address === "object");
      remote = await connectGateway(`http://127.0.0.1:${address.port}`, token, f.directory);
      assert.match(JSON.stringify(remote.source.current().conversation.entries), /Completed while the Mac was away/);
    } finally { await remote.dispose(); await gateway.close(); await reopened.close(); }
  } finally { finish(); await remote.dispose(); await f.close(); }
});

test("remote voice runs audio on the client, speaks only Pi text, and restores reasoning on disconnect", async () => {
  const f = await fixture();
  let emit!: (event: VoiceEvent) => void, starts = 0, stops = 0, finishes = 0;
  const heard: string[] = [];
  const remote = await connectGateway(f.url, token, join(f.directory, "mac-audio"), (config, receive) => {
    assert.equal(config.dataDir, join(f.directory, "mac-audio")); emit = receive;
    return { start: async () => { starts++; }, stop: () => { stops++; }, interrupt: () => {},
      speak: (phrase) => { heard.push(phrase); }, finish: () => { finishes++; } };
  });
  try {
    await remote.controller.submit("/speak", "steer");
    await until(() => starts === 1);
    f.faux.setResponses([fauxAssistantMessage([fauxThinking("Private thinking."), { type: "text", text: "Hello from the gateway." }])]);
    emit({ type: "speech_start", id: 1 });
    emit({ type: "transcript", id: 1, text: "Hello Sage.", endedAt: Date.now() - 500, asrDoneAt: Date.now() });
    await until(() => finishes === 1);
    assert.deepEqual(heard, ["Hello from the gateway."]);
    assert.equal((await f.assistant.harness.snapshot(AgentDoc, f.assistant.root.id, context))!.thinkingLevel, "off");
    let started = false;
    f.faux.setResponses([async (_context, options) => {
      started = true;
      await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage("Obsolete audio.");
    }]);
    emit({ type: "speech_start", id: 2 });
    emit({ type: "transcript", id: 2, text: "One more question.", endedAt: Date.now(), asrDoneAt: Date.now() });
    await until(() => started);
    emit({ type: "speech_start", id: 3 });
    await until(async () => !(await f.assistant.harness.snapshot(LiveDoc, f.assistant.root.id, context))?.run);
    assert.deepEqual(heard, ["Hello from the gateway."], "barge-in must cancel the gateway generation and discard stale audio");
    await remote.dispose();
    assert.equal(stops, 1);
    await until(async () => (await f.assistant.harness.snapshot(AgentDoc, f.assistant.root.id, context))!.thinkingLevel === "low");
    assert.deepEqual(voiceEvent({ type: "audio", epoch: 0, pcm: "private audio", sampleRate: 24000 }), { type: "audio", epoch: 0 });
    assert.throws(() => voiceEvent({ type: "transcript", text: "missing timings" }), /Missing/);
  } finally { await remote.dispose(); await f.close(); }
});

test("a dropped connection stops Mac audio, resynchronizes Pi state, and never replays offline commands", async () => {
  const f = await fixture();
  let starts = 0, stops = 0;
  const remote = await connectGateway(f.url, token, f.directory, () => ({
    start: async () => { starts++; }, stop: () => { stops++; }, interrupt: () => {}, speak: () => {}, finish: () => {},
  }));
  try {
    await remote.controller.submit("/speak", "steer");
    await until(() => starts === 1);
    f.gateway.server.closeAllConnections();
    await until(() => remote.source.current().notices.some((item) => item.message.includes("Reconnecting")));
    await remote.controller.submit("Do not replay this offline message.", "steer");
    assert.equal(stops, 1);
    await until(() => !remote.source.current().notices.some((item) => item.message.includes("disconnected")));
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(starts, 1, "reconnecting must not reopen the microphone");
    assert.equal((await f.assistant.harness.snapshot(AgentDoc, f.assistant.root.id, context))!.thinkingLevel, "low");
    f.faux.setResponses([fauxAssistantMessage("Fresh reply after reconnect.")]);
    await remote.controller.submit("New request.", "steer");
    await until(() => JSON.stringify(remote.source.current().conversation.entries).includes("Fresh reply after reconnect."));
    assert.doesNotMatch(JSON.stringify(remote.source.current().conversation.entries), /Do not replay/);
  } finally { await remote.dispose(); await f.close(); }
});
