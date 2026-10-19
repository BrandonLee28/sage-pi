import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { context, openAssistant } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";
import { Index, MemoryRecords } from "../src/personal.ts";
import { Routines } from "../extensions/routines.ts";
import { agentOf, tuiAdapter } from "../src/tui-adapter.ts";
import { localModels, singleStream } from "../src/model.ts";
import { telegramGateway } from "../src/telegram.ts";
import { Api, Bot } from "grammy";
import { getCurrentSystemPrompt, getCurrentTools, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "personal-pi-test-"));
  const config = {
    ...readConfig(),
    dataDir,
    enableShell: false,
    telegramToken: "",
    telegramChat: "",
    searxngUrl: "",
    firecrawlUrl: "",
    lightpandaUrl: "",
    appleId: "",
    appleAppPassword: "",
    appleCalendarUrl: "",
  };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider({ ...faux.provider, ...singleStream(faux.provider) });
  const open = (sendTelegram?: (text: string, threadId?: number) => Promise<void>) =>
    openAssistant(config, {
      models,
      model: { provider: "faux", modelId: "faux-1" },
      sendTelegram,
    });
  return {
    config,
    faux,
    open,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

test("Sage's soul enters the native prompt, refreshes live, and preserves edits on restart", async () => {
  const f = await fixture();
  let assistant = await f.open();
  const soulPath = join(assistant.workspace, "SOUL.md");
  const defaultSoul = await readFile(new URL("../instructions/SOUL.md", import.meta.url), "utf8");
  const prompt = async () => getCurrentSystemPrompt((await assistant.root.context(context)).messages);
  try {
    f.faux.setResponses([fauxAssistantMessage("Hello."), fauxAssistantMessage("Updated."), fauxAssistantMessage("Still Sage.")]);
    assert.equal((await (await assistant.submit("Hello.")).wait(context)).status, "done");
    assert.equal(await readFile(soulPath, "utf8"), defaultSoul);
    assert.ok((await prompt()).includes(defaultSoul));
    const customSoul = "You are Sage. Custom personality: a dry sense of humor.";
    await writeFile(soulPath, customSoul);
    assert.equal((await (await assistant.submit("Hello again.")).wait(context)).status, "done");
    assert.ok((await prompt()).includes(customSoul));
    await assistant.close();
    assistant = await f.open();
    assert.equal(await readFile(soulPath, "utf8"), customSoul);
    const topic = await assistant.telegramConversation(44);
    assert.equal((await (await assistant.submit("Hello from a topic.", undefined, false, true, topic)).wait(context)).status, "done");
    assert.ok(getCurrentSystemPrompt((await topic.context(context)).messages).includes(customSoul));
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("Telegram texting instructions cover replies, files, scheduled check-ins, and restart without overwriting the workspace", async () => {
  const f = await fixture();
  const workspace = join(f.config.dataDir, "workspace");
  const agentsPath = join(workspace, "AGENTS.md");
  const customInstructions = "Keep these existing runtime instructions.";
  await mkdir(workspace, { recursive: true });
  await writeFile(agentsPath, customInstructions);
  const send = async () => {};
  let assistant = await f.open(send);
  const stylePath = join(workspace, "TELEGRAM.md");
  let style = await readFile(new URL("../instructions/TELEGRAM.md", import.meta.url), "utf8");
  const assertStyle = async (conversation = assistant.root) => {
    const prompt = getCurrentSystemPrompt((await conversation.context(context)).messages);
    assert.ok(prompt.includes(customInstructions));
    assert.ok(prompt.includes("<telegram_reply_style>"));
    assert.ok(prompt.includes(style));
  };
  try {
    assert.equal(await readFile(stylePath, "utf8"), style);
    f.faux.setResponses([
      fauxAssistantMessage("Hey, what's up?"),
      fauxAssistantMessage(fauxToolCall("write", { path: "report.md", content: "# Report\n\n**Complete.**\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done. I saved it in report.md."),
      fauxAssistantMessage("Time to check in."),
      fauxAssistantMessage("Still here."),
      fauxAssistantMessage("Terminal only."),
    ]);
    await (await assistant.submit("Hello.", undefined, true)).wait(context);
    await assertStyle();
    style += "\nCustom voice: keep it straightforward.\n";
    await writeFile(stylePath, style);
    const topic = await assistant.telegramConversation(46);
    await (await assistant.submit("Save a Markdown report.", undefined, true, true, topic)).wait(context);
    await assertStyle(topic);
    assert.equal(await readFile(join(workspace, "report.md"), "utf8"), "# Report\n\n**Complete.**\n");
    await (await assistant.submit("Scheduled check-in.", undefined, true, false, topic)).wait(context);
    await assertStyle(topic);

    await assistant.close();
    assistant = await f.open(send);
    assert.equal(await readFile(agentsPath, "utf8"), customInstructions);
    assert.equal(await readFile(stylePath, "utf8"), style);
    const restoredTopic = await assistant.telegramConversation(46);
    assert.equal(restoredTopic.id, topic.id);
    await (await assistant.submit("Hello again.", undefined, true, true, restoredTopic)).wait(context);
    await assertStyle(restoredTopic);

    await assistant.close();
    assistant = await f.open();
    const terminalTopic = await assistant.telegramConversation(46);
    await (await assistant.submit("Terminal only.", undefined, false, true, terminalTopic)).wait(context);
    const prompt = getCurrentSystemPrompt((await terminalTopic.context(context)).messages);
    assert.ok(!prompt.includes("<telegram_reply_style>"));
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("Telegram rewrites a formatted draft through the native loop before delivery without repeating file work", async () => {
  const f = await fixture();
  const sent: { text: string; threadId?: number }[] = [];
  const assistant = await f.open(async (text, threadId) => { sent.push({ text, threadId }); });
  try {
    const topic = await assistant.telegramConversation(47);
    const reply = "tomorrow you've got two meetings:\n\n2–3 pm: project check-in, room 10\n4–5 pm: design review, room 12";
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "schedule.md", content: "# Tomorrow\n\n**2–3 pm** project check-in\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Tomorrow you've got two:\n\n- **2–3 pm** — project check-in, room 10\n- **4–5 pm** — design review, room 12\n\nWant me to plan your evening?"),
      (request) => {
        assert.equal(getCurrentTools(request.messages).length, 0, "A wording correction cannot repeat tool actions");
        return fauxAssistantMessage(reply);
      },
    ]);
    const settled = await (await assistant.submit("Save my schedule, then tell me what's on tomorrow.",
      undefined, true, true, topic)).wait(context);
    assert.equal(settled.status, "done");
    for (let i = 0; i < 100 && sent.length === 0; i++) await pause(10);
    assert.deepEqual(sent, [{ text: reply, threadId: 47 }]);
    assert.equal(f.faux.state.callCount, 3);
    assert.equal(await readFile(join(assistant.workspace, "schedule.md"), "utf8"),
      "# Tomorrow\n\n**2–3 pm** project check-in\n");
    const view = await topic.context(context);
    assert.equal(view.messages.filter((message) => message.role === "toolResult" && message.toolName === "write").length, 1);
    assert.ok(JSON.stringify(view.messages).includes("This is a wording correction only"));
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("Telegram style correction is bounded, covers JSON and scheduled replies, and honors explicit inline formats", async () => {
  const f = await fixture();
  const assistant = await f.open(async () => {});
  try {
    f.faux.setResponses([
      fauxAssistantMessage("**First draft.**"), fauxAssistantMessage("**Still formatted.**"),
      fauxAssistantMessage('{"status":"done"}'), fauxAssistantMessage("All done."),
      fauxAssistantMessage('{"status":"done"}'),
      fauxAssistantMessage("# Saved report"), fauxAssistantMessage("Saved it in report.md."),
      (request) => {
        assert.ok(getCurrentTools(request.messages).length > 0, "Tools remain available on the next user request");
        return fauxAssistantMessage("2–3 pm: check-in. See https://example.com/a_b?q=1&x=2");
      },
    ]);
    assert.equal((await (await assistant.submit("Hello.")).wait(context)).status, "done");
    assert.equal(f.faux.state.callCount, 2, "An uncooperative model cannot create an endless rewrite loop");
    assert.equal((await (await assistant.submit("Scheduled check-in.", undefined, true, false)).wait(context)).status, "done");
    assert.equal(f.faux.state.callCount, 4, "The next request gets its own correction attempt");
    await (await assistant.submit("Reply in JSON with the status.")).wait(context);
    assert.equal(f.faux.state.callCount, 5);
    await (await assistant.submit("Save a Markdown report in a file.")).wait(context);
    assert.equal(f.faux.state.callCount, 7, "A file format request does not opt chat out of plain text");
    await (await assistant.submit("When is the check-in?")).wait(context);
    assert.equal(f.faux.state.callCount, 8, "Plain schedules and bare URLs need no extra model request");
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("Telegram shortens dense plain text, preserves existing voice files, and leaves requested detail intact", async () => {
  const f = await fixture();
  const workspace = join(f.config.dataDir, "workspace");
  await mkdir(workspace, { recursive: true });
  const voicePath = join(workspace, "TELEGRAM.md");
  await writeFile(voicePath, "Keep my custom voice.");
  const sent: string[] = [];
  const assistant = await f.open(async (text) => { sent.push(text); });
  const dense = "Here is another recap of the plan with several unnecessary alternatives. ".repeat(10);
  const brief = "Start the reading after lunch. Leave the errands for later.";
  try {
    assert.equal(await readFile(voicePath, "utf8"), "Keep my custom voice.");
    assert.ok((await readFile(join(workspace, "TELEGRAM-BREVITY.md"), "utf8")).includes("1–3 short sentences"));
    f.faux.setResponses([
      fauxAssistantMessage(dense),
      (request) => {
        assert.equal(getCurrentTools(request.messages).length, 0);
        assert.ok(getCurrentSystemPrompt(request.messages).includes("<telegram_brevity>"));
        return fauxAssistantMessage(brief);
      },
      fauxAssistantMessage(dense), fauxAssistantMessage(dense),
      fauxAssistantMessage(dense), fauxAssistantMessage(dense),
      fauxAssistantMessage(brief),
    ]);
    assert.equal((await (await assistant.submit("Okay, I'll do the reading after lunch.", undefined, true)).wait(context)).status, "done");
    for (let i = 0; i < 100 && sent.length === 0; i++) await pause(10);
    assert.deepEqual(sent, [brief], "Only the shortened answer is delivered");
    assert.equal(f.faux.state.callCount, 2);
    await (await assistant.submit("Give me the full detailed plan.")).wait(context);
    const detailed = (await assistant.root.context(context)).messages.findLast((message) => message.role === "assistant");
    assert.ok(detailed?.role === "assistant" && detailed.content.some((part) => part.type === "text" && part.text === dense),
      "Requested detail is not cut off by a transport word limit");
    await (await assistant.submit("What should I do next?")).wait(context);
    assert.equal(f.faux.state.callCount, 6, "An overlong second draft cannot cause an endless rewrite loop");
    await (await assistant.submit("Got it.")).wait(context);
    assert.equal(f.faux.state.callCount, 7, "An already brief answer needs no correction");
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("USER.md is seeded, refreshes across conversations, and preserves edits on restart", async () => {
  const f = await fixture();
  let assistant = await f.open();
  const profilePath = join(assistant.workspace, "USER.md");
  const prompt = async () => getCurrentSystemPrompt((await assistant.root.context(context)).messages);
  try {
    assert.equal(await readFile(profilePath, "utf8"),
      await readFile(new URL("../instructions/USER.md", import.meta.url), "utf8"));
    f.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("Hello.")));
    const original = "# User\nPreferred name: Test User.\nUse one clear next action.";
    await writeFile(profilePath, original);
    assert.equal((await (await assistant.submit("Hello.")).wait(context)).status, "done");
    assert.ok((await prompt()).includes(original));

    const updated = "# User\nPreferred name: Test User.\nUse short numbered steps.";
    await writeFile(profilePath, updated);
    assert.equal((await (await assistant.submit("Hello again.")).wait(context)).status, "done");
    assert.ok((await prompt()).includes(updated));
    assert.ok(!(await prompt()).includes(original));
    const topic = await assistant.telegramConversation(45);
    assert.equal((await (await assistant.submit("Hello from a topic.", undefined, false, true, topic)).wait(context)).status, "done");
    assert.ok(getCurrentSystemPrompt((await topic.context(context)).messages).includes(updated));

    await assistant.close();
    assistant = await f.open();
    assert.equal(await readFile(profilePath, "utf8"), updated);
    assert.equal((await (await assistant.submit("Still here.")).wait(context)).status, "done");
    assert.ok((await prompt()).includes(updated));
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("USER.md bounds prompt text without changing the file, and allows empty or missing profiles", async () => {
  const f = await fixture();
  const workspace = join(f.config.dataDir, "workspace");
  const profilePath = join(workspace, "USER.md");
  const prefix = "# User\n" + "x".repeat(1993);
  const full = prefix + "PROFILE_OVERFLOW_MUST_NOT_BE_AUTOLOADED";
  await mkdir(workspace, { recursive: true });
  await writeFile(profilePath, full);
  const assistant = await f.open();
  const prompt = async () => getCurrentSystemPrompt((await assistant.root.context(context)).messages);
  try {
    // Opening an existing workspace must preserve even an oversized profile.
    assert.equal(await readFile(profilePath, "utf8"), full);
    f.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("OK.")));
    assert.equal((await (await assistant.submit("Hello.")).wait(context)).status, "done");
    assert.ok((await prompt()).includes(prefix));
    assert.ok((await prompt()).includes("[USER.md truncated to 2,000 characters."));
    assert.ok(!(await prompt()).includes("PROFILE_OVERFLOW_MUST_NOT_BE_AUTOLOADED"));
    assert.equal(await readFile(profilePath, "utf8"), full);

    await writeFile(profilePath, " \n");
    assert.equal((await (await assistant.submit("Empty profile.")).wait(context)).status, "done");
    assert.ok(!(await prompt()).includes("<user_profile>"));
    await rm(profilePath);
    assert.equal((await (await assistant.submit("Missing profile.")).wait(context)).status, "done");
    assert.ok(!(await prompt()).includes("<user_profile>"));

    // The exact boundary fits without a truncation notice.
    await writeFile(profilePath, prefix);
    assert.equal((await (await assistant.submit("Restored profile.")).wait(context)).status, "done");
    assert.ok((await prompt()).includes(prefix));
    assert.ok(!(await prompt()).includes("[USER.md truncated"));
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("native tool execution, memory retrieval, idempotent submission, and editable instructions survive reopen", async () => {
  const f = await fixture();
  let assistant = await f.open();
  try {
    f.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("memory", {
          action: "save",
          key: "preferences/messages",
          text: "Keep messages short.",
          source: "test user",
          pinned: true,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Saved."),
    ]);
    const first = await assistant.submit("Remember my preference.", "memory-1");
    assert.equal((await first.wait(context)).status, "done");
    assert.equal(
      (await assistant.submit("Remember my preference.", "memory-1")).id,
      first.id,
    );
    assert.equal(f.faux.state.callCount, 2);
    const marker = "Custom instructions retained after restart.";
    await writeFile(join(assistant.workspace, "AGENTS.md"), marker);
    await assistant.close();
    assistant = await f.open();
    const restoredView = await assistant.root.viewState(context);
    assert.ok(JSON.stringify(restoredView.value.entries).includes('Saved.'));
    restoredView.dispose();
    assert.equal(
      await readFile(join(assistant.workspace, "AGENTS.md"), "utf8"),
      marker,
    );
    assert.equal(
      (await assistant.personalState()).memories[0].source,
      "test user",
    );
    f.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("memory", { action: "search", query: "short" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("You prefer short messages."),
    ]);
    assert.equal(
      (
        await (
          await assistant.submit("What do I prefer?", "memory-2")
        ).wait(context)
      ).status,
      "done",
    );
    const view = await assistant.root.context(context);
    assert.ok(JSON.stringify(view.messages).includes(marker));
    assert.ok(
      view.messages.some(
        (m) =>
          m.role === "toolResult" &&
          JSON.stringify(m.content).includes("Keep messages short"),
      ),
    );
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("native timer recovers after restart, ignores superseded wakes, and cancelled responsibilities stay quiet", async () => {
  const f = await fixture();
  let assistant = await f.open();
  try {
    f.faux.setResponses([
      fauxAssistantMessage("Time for the scheduled check-in."),
    ]);
    await assistant.saveCommitment({
      id: "stretch",
      title: "Stretch",
      wakeAt: new Date(Date.now() + 400).toISOString(),
    });
    await assistant.saveCommitment({
      id: "stretch",
      wakeAt: new Date(Date.now() + 1400).toISOString(),
    });
    await assistant.saveCommitment({
      id: "cancelled",
      title: "Cancelled",
      wakeAt: new Date(Date.now() + 500).toISOString(),
    });
    await assistant.saveCommitment({ id: "cancelled", status: "cancelled" });
    await assistant.close();
    assistant = await f.open();
    await pause(700);
    assert.equal(f.faux.state.callCount, 0);
    for (let i = 0; i < 80 && f.faux.state.callCount === 0; i++)
      await pause(50);
    await assistant.root.waitForIdle(context);
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(
      (await assistant.personalState()).commitments.find(
        (c) => c.id === "stretch",
      )?.wakeAt,
      null,
    );
    await assistant.close();
    assistant = await f.open();
    await pause(100);
    assert.equal(f.faux.state.callCount, 1);
    const entries = await assistant.root.entries({}, 100, undefined, context);
    assert.equal(
      entries.items.filter((entry) =>
        entry.model?.some(
          (m) =>
            m.role === "user" &&
            String(m.content).includes("Scheduled check-in"),
        ),
      ).length,
      1,
    );
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("upstream TUI adapter submits, renders saved state, and reports native errors", async () => {
  const f = await fixture();
  const assistant = await f.open();
  const adapter = await tuiAdapter(assistant, f.config);
  try {
    f.faux.setResponses([
      fauxAssistantMessage("Hello from the native harness."),
    ]);
    await adapter.controller.submit("Hello", "steer");
    await assistant.root.waitForIdle(context);
    assert.ok(
      JSON.stringify(adapter.source.current().conversation).includes(
        "Hello from the native harness.",
      ),
    );
    assert.equal(adapter.source.current().models[0].modelId, "faux-1");
    assert.equal(adapter.source.current().tasks, undefined);
    await adapter.controller.toggleTasks();
    assert.ok(adapter.source.current().tasks);
    await adapter.controller.toggleTasks();
    assert.equal(adapter.source.current().tasks, undefined);
    await adapter.controller.setModel({
      provider: "missing",
      modelId: "missing",
    });
    assert.ok(
      adapter.source
        .current()
        .notices.some((n) => n.message.includes("not configured")),
    );
    await assert.rejects(
      assistant.saveCommitment({
        id: "bad-date",
        title: "Bad date",
        wakeAt: "2030-01-01T10:00:00",
      }),
      /timezone/,
    );
  } finally {
    adapter.dispose();
    await assistant.close();
    await f.cleanup();
  }
});

test("new TUI sessions isolate history, keep model preferences, and restore across restart", async () => {
  const f = await fixture();
  let assistant = await f.open();
  let adapter = await tuiAdapter(assistant, f.config);
  try {
    f.faux.setResponses([fauxAssistantMessage("MAIN-ONLY answer."), fauxAssistantMessage("NEW-SESSION-ONLY answer.")]);
    await adapter.controller.submit("MAIN-ONLY message", "steer");
    await assistant.root.waitForIdle(context);
    await adapter.controller.cycleThinking();
    const previousAgent = agentOf(adapter.source.current().conversation);
    const calls = f.faux.state.callCount;
    await adapter.controller.submit("/new", "steer");
    const fresh = adapter.source.current();
    const id = fresh.conversation.conversation.id;
    assert.notEqual(id, assistant.root.id);
    assert.equal(f.faux.state.callCount, calls, "creating a session must not call the model");
    assert.equal(fresh.conversations.find((item) => item.id === id)?.label, "Session 1");
    assert.deepEqual(agentOf(fresh.conversation).model, previousAgent.model);
    assert.equal(agentOf(fresh.conversation).thinkingLevel, previousAgent.thinkingLevel);
    assert.equal(agentOf(fresh.conversation).cwd, assistant.workspace);
    assert.doesNotMatch(JSON.stringify(fresh.conversation.entries), /MAIN-ONLY/);
    await adapter.controller.submit("NEW-SESSION-ONLY message", "steer");
    await assistant.harness.waitForIdle(context);
    assert.match(JSON.stringify(adapter.source.current().conversation), /NEW-SESSION-ONLY answer/);
    await adapter.controller.switchConversation(assistant.root.id);
    assert.match(JSON.stringify(adapter.source.current().conversation), /MAIN-ONLY answer/);
    assert.doesNotMatch(JSON.stringify(adapter.source.current().conversation), /NEW-SESSION-ONLY/);
    await adapter.controller.switchConversation(id);
    assert.match(JSON.stringify(adapter.source.current().conversation), /NEW-SESSION-ONLY/);
    adapter.dispose();
    await assistant.close();
    assistant = await f.open();
    adapter = await tuiAdapter(assistant, f.config);
    assert.equal(adapter.source.current().conversation.conversation.id, id);
    assert.equal(adapter.source.current().conversations.find((item) => item.id === id)?.label, "Session 1");
    assert.match(JSON.stringify(adapter.source.current().conversation), /NEW-SESSION-ONLY answer/);
    assert.equal(agentOf(adapter.source.current().conversation).thinkingLevel, previousAgent.thinkingLevel);
    await adapter.controller.newSession();
    assert.equal(adapter.source.current().conversations.length, 3);
    assert.equal(adapter.source.current().conversations.at(-1)?.label, "Session 2");
    assert.doesNotMatch(JSON.stringify(adapter.source.current().conversation.entries), /MAIN-ONLY|NEW-SESSION-ONLY/);
  } finally { adapter.dispose(); await assistant.close(); await f.cleanup(); }
});

test("skills and memory inspectors read current shared state without inference or writes", async () => {
  const f = await fixture();
  const assistant = await f.open();
  const skillPath = join(assistant.workspace, "skills/observer/SKILL.md");
  const skill = "---\nname: observer\ndescription: An inspection test skill.\n---\nFull skill instructions.\n";
  const profile = "Profile text. ".repeat(200);
  await mkdir(join(assistant.workspace, "skills/observer"), { recursive: true });
  await mkdir(join(assistant.workspace, "skills/unreadable"), { recursive: true });
  await writeFile(skillPath, skill);
  await writeFile(join(assistant.workspace, "USER.md"), profile);
  await assistant.root.commit(async (tx) => {
    const index = await tx.doc(Index, assistant.root.id);
    for (let number = 0; number < 10; number++) {
      const key = `test-${number}`;
      await tx.doc(MemoryRecords, assistant.root.id, key, { key, text: `Fact ${number}`, source: "test fixture", pinned: number < 9, updatedAt: 1000 });
      index.memories.push(key);
    }
  }, context);
  const adapter = await tuiAdapter(assistant, f.config);
  try {
    const before = await assistant.personalState();
    const entries = JSON.stringify(adapter.source.current().conversation.entries);
    const skills = await adapter.controller.inspect("skills");
    assert.ok(skills);
    assert.equal(skills.items.find((item) => item.label === "observer")?.description, "An inspection test skill.");
    assert.ok(skills.items.find((item) => item.label === "observer")?.body.includes(skill));
    assert.match(skills.items.find((item) => item.label === "unreadable")?.description ?? "", /missing or unreadable/);
    const memory = await adapter.controller.inspect("memory");
    assert.ok(memory);
    assert.match(memory.description, /10 saved · 8 included/);
    assert.match(memory.items.find((item) => item.value === "profile")?.description ?? "", /2000 characters/);
    assert.ok(memory.items.find((item) => item.value === "profile")?.body.includes(profile));
    assert.match(memory.items.find((item) => item.label === "test-0")?.description ?? "", /outside the last 8/);
    assert.match(memory.items.find((item) => item.label === "test-8")?.description ?? "", /included on next request/);
    assert.match(memory.items.find((item) => item.label === "test-9")?.description ?? "", /retrieved on demand/);
    assert.match(memory.items.find((item) => item.label === "test-8")?.body ?? "", /Source: test fixture[\s\S]*1970-01-01T00:00:01.000Z[\s\S]*Fact 8/);
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(JSON.stringify(adapter.source.current().conversation.entries), entries);
    assert.deepEqual(await assistant.personalState(), before);
    assert.equal(await readFile(skillPath, "utf8"), skill);
    await writeFile(skillPath, skill.replace("inspection test", "freshly updated"));
    assert.match((await adapter.controller.inspect("skills"))?.items.find((item) => item.label === "observer")?.description ?? "", /freshly updated/);
    await adapter.controller.newSession();
    assert.deepEqual((await adapter.controller.inspect("memory"))?.items, memory.items);
    f.faux.setResponses([fauxAssistantMessage("Ready.")]);
    await adapter.controller.submit("Hello.", "steer");
    await assistant.harness.waitForIdle(context);
    const selected = await assistant.harness.conversation(adapter.source.current().conversation.conversation.id, context);
    assert.ok(selected);
    const prompt = getCurrentSystemPrompt((await selected.context(context)).messages);
    assert.match(prompt, /skills\/observer\/SKILL.md: An freshly updated skill/);
  } finally { adapter.dispose(); await assistant.close(); await f.cleanup(); }
});

test("schedule inspector lists shared cron routines and reminder wakes without changing them", async () => {
  const f = await fixture();
  const assistant = await f.open();
  const adapter = await tuiAdapter(assistant, f.config);
  try {
    const empty = await adapter.controller.inspect("schedules");
    assert.deepEqual(empty?.items, []);
    assert.match(empty?.description ?? "", /No schedules saved/);
    const at = Date.now() + 86400000;
    await assistant.root.commit(async (tx) => {
      const state = await tx.doc(Routines);
      state.items.daily = {
        id: "daily", title: "Daily review", instructions: "Review the saved test notes.",
        cron: "0 9 * * *", timezone: "America/New_York", paused: false,
        nextAt: at + 3600000, taskId: null, conversationId: assistant.root.id,
        lastRunAt: at - 86400000, lastStatus: "done",
      };
      state.items.paused = { ...state.items.daily, id: "paused", title: "Paused review", paused: true, nextAt: null, lastRunAt: null, lastStatus: "not-run" };
    }, context);
    await assistant.saveCommitment({ id: "wake", title: "Test reminder", nextAction: "Review test data.", source: "test fixture", wakeAt: new Date(at).toISOString() });
    await assistant.saveCommitment({ id: "due-only", title: "Due date only", dueAt: new Date(at).toISOString() });
    await assistant.saveCommitment({ id: "cancelled", title: "Cancelled reminder", wakeAt: new Date(at).toISOString(), status: "cancelled" });
    const beforeRoutines = await assistant.harness.snapshot(Routines, context);
    const beforePersonal = await assistant.personalState();
    const entries = JSON.stringify(adapter.source.current().conversation.entries);
    const schedules = await adapter.controller.inspect("schedules");
    assert.ok(schedules);
    assert.match(schedules.description, /2 recurring · 1 reminders/);
    assert.deepEqual(schedules.items.map((item) => item.value), ["reminder:wake", "routine:daily", "routine:paused"]);
    assert.match(schedules.items[0].body, /One-time reminder: wake[\s\S]*Source: test fixture[\s\S]*Review test data/);
    assert.ok(schedules.items[0].body.includes(new Date(at).toISOString()));
    assert.ok(schedules.items[0].body.includes(f.config.timezone));
    assert.match(schedules.items[1].body, /Status: Enabled\nCron: 0 9 \* \* \*\nTimezone: America\/New_York/);
    assert.ok(schedules.items[1].body.includes(new Date(at + 3600000).toLocaleString("en-US", { timeZone: "America/New_York" })));
    assert.match(schedules.items[1].body, /Last result: done[\s\S]*Review the saved test notes/);
    assert.match(schedules.items[2].description, /Paused/);
    assert.match(schedules.items[2].body, /Next run: None[\s\S]*Last run: None/);
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(JSON.stringify(adapter.source.current().conversation.entries), entries);
    assert.deepEqual(await assistant.harness.snapshot(Routines, context), beforeRoutines);
    assert.deepEqual(await assistant.personalState(), beforePersonal);
    await adapter.controller.newSession();
    assert.deepEqual((await adapter.controller.inspect("schedules"))?.items, schedules.items);
    await assistant.root.commit(async (tx) => { delete (await tx.doc(Routines)).items.paused; }, context);
    assert.equal((await adapter.controller.inspect("schedules"))?.items.length, 2);
  } finally { adapter.dispose(); await assistant.close(); await f.cleanup(); }
});

test("local-model quoted null dates clear through the native tool path", async () => {
  const f = await fixture();
  const assistant = await f.open();
  try {
    await assistant.saveCommitment({
      id: "clear-dates",
      title: "Clear dates",
      wakeAt: new Date(Date.now() + 60000).toISOString(),
    });
    f.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("commitment", {
          action: "save",
          id: "clear-dates",
          status: "done",
          dueAt: "null",
          wakeAt: "null",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Done."),
    ]);
    assert.equal(
      (
        await (
          await assistant.submit("Mark it done.", "clear-null")
        ).wait(context)
      ).status,
      "done",
    );
    const item = (await assistant.personalState()).commitments[0];
    assert.equal(item.status, "done");
    assert.equal(item.wakeAt, null);
    assert.equal(item.dueAt, null);
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("durable delivery sends an answer once and stays completed after reopen", async () => {
  const f = await fixture();
  const sent: string[] = [];
  const models = createModels();
  models.setProvider(f.faux.provider);
  const open = () =>
    openAssistant(f.config, {
      models,
      model: { provider: "faux", modelId: "faux-1" },
      sendTelegram: async (value) => {
        sent.push(value);
      },
    });
  let assistant = await open();
  try {
    f.faux.setResponses([async () => {
      // Real inference finishes after the delivery task has started waiting.
      await pause(150);
      return fauxAssistantMessage([
        { type: "thinking", thinking: "Keep the response concise." },
        { type: "text", text: "Here is your update." },
      ]);
    }]);
    await (
      await assistant.submit("Check in.", "delivery-test", true)
    ).wait(context);
    for (let i = 0; i < 100 && sent.length === 0; i++) await pause(10);
    assert.deepEqual(sent, ["Here is your update."]);
    // Allow the send receipt to commit before reopening.
    for (let i = 0; i < 100; i++) {
      const graph = await assistant.harness.taskGraph(context);
      const active = Object.values(graph.value.tasks).some(
        (t) => t.kind === "personal.telegram-delivery",
      );
      graph.dispose();
      if (!active) break;
      await pause(10);
    }
    await assistant.close();
    assistant = await open();
    await pause(50);
    assert.deepEqual(sent, ["Here is your update."]);
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("thinking-only or blank model replies produce an explicit Telegram notice instead of silent success", async () => {
  const f = await fixture();
  const sent: { text: string; thread?: number }[] = [];
  const assistant = await f.open(async (text, thread) => { sent.push({ text, thread }); });
  try {
    const topic = await assistant.telegramConversation(768);
    for (const [index, response] of [
      fauxAssistantMessage({ type: "thinking", thinking: "Private reasoning must not be sent." }, { stopReason: "length" }),
      fauxAssistantMessage("   "),
    ].entries()) {
      f.faux.setResponses([response]);
      assert.equal((await (await assistant.submit("Please answer.", `empty-reply-${index}`, true, true, topic)).wait(context)).status, "done");
      for (let i = 0; i < 100 && sent.length <= index; i++) await pause(10);
      assert.equal(sent.length, index + 1);
      assert.equal(sent[index].thread, 768);
      assert.ok(sent[index].text.trim().length > 0);
      assert.ok(sent[index].text.includes("Your request isn't finished"));
      assert.ok(!sent[index].text.includes("Private reasoning"));
    }
    assert.ok(sent[0].text.includes("response limit"));
    assert.ok(sent[1].text.includes("without producing an answer"));
  } finally { await assistant.close(); await f.cleanup(); }
});

test("configured search and extraction run through native tools without live services", async (t) => {
  const f = await fixture();
  f.config.searxngUrl = "https://search.invalid/";
  f.config.firecrawlUrl = "https://extract.invalid";
  f.config.firecrawlKey = "test-only-key";
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (
    input: string | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(input);
    requests.push(url.hostname);
    if (url.hostname === "search.invalid") {
      assert.equal(url.pathname, "/search");
      assert.equal(url.searchParams.get("q"), "school deadlines");
      assert.equal(url.searchParams.get("format"), "json");
      return Response.json({
        results: [{
          title: "Assignments",
          url: "https://school.invalid/tasks",
          content: "Paper due Friday.",
        }],
      });
    }
    assert.equal(url.hostname, "extract.invalid");
    assert.equal(url.pathname, "/v1/scrape");
    assert.equal(init?.method, "POST");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer test-only-key",
    );
    assert.deepEqual(JSON.parse(String(init?.body)), {
      url: "https://school.invalid/tasks",
      formats: ["markdown"],
      onlyMainContent: true,
    });
    return Response.json({
      success: true,
      data: { markdown: "# Assignments\nPaper due Friday." },
    });
  });
  const assistant = await f.open();
  try {
    f.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("web_search", { query: "school deadlines" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("web_extract", { url: "https://school.invalid/tasks" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("The paper is due Friday."),
    ]);
    const settled = await (
      await assistant.submit("Find my deadline.", "web-setup-test")
    ).wait(context);
    assert.equal(settled.status, "done");
    assert.deepEqual(requests, ["search.invalid", "extract.invalid"]);
    const view = await assistant.root.context(context);
    const results = view.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => !result.isError));
    assert.ok(JSON.stringify(results).includes("# Assignments"));
    assert.ok(!JSON.stringify(results).includes("test-only-key"));
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("native bash can run the bundled Google CLI and the Gmail skill is installed", async () => {
  const f = await fixture();
  f.config.enableShell = true;
  const assistant = await f.open();
  try {
    f.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "gws --version" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Google CLI is available."),
    ]);
    const settled = await (
      await assistant.submit("Check the Google CLI version.", "google-cli-test")
    ).wait(context);
    assert.equal(settled.status, "done");
    const view = await assistant.root.context(context);
    assert.ok(view.messages.some((message) =>
      message.role === "toolResult" && message.toolName === "bash" &&
      !message.isError && JSON.stringify(message.content).includes("gws 0.22.5"),
    ));
    assert.ok((await readFile(
      join(assistant.workspace, "skills/gmail/SKILL.md"), "utf8",
    )).includes("gws gmail +triage"));
  } finally {
    await assistant.close();
    await f.cleanup();
  }
});

test("Telegram threads isolate history, share personal state, and retain wake routes across restart", async () => {
  const f = await fixture();
  const sent: { text: string; threadId?: number }[] = [];
  const send = async (text: string, threadId?: number) => { sent.push({ text, threadId }); };
  let assistant = await f.open(send);
  const adapter = await tuiAdapter(assistant, f.config);
  try {
    const [school, other] = await Promise.all([
      assistant.telegramConversation(101), assistant.telegramConversation(202),
    ]);
    assert.notEqual(school.id, other.id);
    assert.equal((await assistant.telegramConversation(101)).id, school.id);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("memory", {
        action: "save", key: "preferences/time", text: "Prefers mornings.", pinned: true,
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("commitment", {
        action: "save", id: "thread-reminder", title: "Review assignment",
        wakeAt: new Date(Date.now() + 1000).toISOString(),
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("School reply."),
    ]);
    await (await assistant.submit("SCHOOL-ONLY transcript", "thread-school", true, true, school)).wait(context);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("memory", { action: "search", query: "mornings" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("commitment", { action: "list" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Other reply."),
    ]);
    await (await assistant.submit("OTHER-ONLY transcript", "thread-other", true, true, other)).wait(context);
    const schoolContext = JSON.stringify((await school.context(context)).messages);
    const otherContext = JSON.stringify((await other.context(context)).messages);
    assert.ok(!schoolContext.includes("OTHER-ONLY"));
    assert.ok(!otherContext.includes("SCHOOL-ONLY"));
    assert.ok(otherContext.includes("Prefers mornings."));
    assert.ok(otherContext.includes("Review assignment"));
    assert.equal(adapter.source.current().conversations.length, 3);
    await adapter.controller.switchConversation(other.id);
    assert.equal(adapter.source.current().conversation.conversation.id, other.id);
    assert.ok(JSON.stringify(adapter.source.current().conversation).includes("Other reply."));
    for (let i = 0; i < 100 && sent.length < 2; i++) await pause(10);
    assert.deepEqual(sent, [
      { text: "School reply.", threadId: 101 },
      { text: "Other reply.", threadId: 202 },
    ]);
    adapter.dispose();
    await assistant.close();
    f.faux.setResponses([fauxAssistantMessage("Scheduled school follow-up.")]);
    assistant = await f.open(send);
    assert.equal((await assistant.telegramConversation(101)).id, school.id);
    for (let i = 0; i < 150 && sent.length < 3; i++) await pause(20);
    assert.deepEqual(sent[2], { text: "Scheduled school follow-up.", threadId: 101 });
    assert.equal((await assistant.personalState()).commitments[0].wakeAt, null);
  } finally {
    adapter.dispose();
    await assistant.close();
    await f.cleanup();
  }
});

test("Telegram gateway preserves topics on every reply chunk and admits only its owner", async (t) => {
  const f = await fixture();
  const requests: { chat_id: number | string; text: string; message_thread_id?: number }[] = [];
  const actions: { chat: number | string; thread?: number }[] = [];
  const bot = new Bot("123456:test-only-token", {
    botInfo: {
      id: 123456, is_bot: true, first_name: "Test", username: "testbot",
      can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: true,
      allows_users_to_create_topics: true, can_manage_bots: false, supports_join_request_queries: false,
    },
    client: { fetch: async () => { throw new Error("No network allowed in this test"); } },
  });
  t.mock.method(bot, "start", async () => {});
  t.mock.method(Api.prototype, "sendChatAction", async (...[chat, action, options]: Parameters<typeof bot.api.sendChatAction>) => {
    assert.equal(action, "typing");
    actions.push({ chat, thread: options?.message_thread_id });
    if (actions.length === 1) throw new Error("Simulated presence failure");
    return true as const;
  });
  t.mock.method(Api.prototype, "sendMessage", async (
    ...[chat_id, text, options]: Parameters<typeof bot.api.sendMessage>
  ) => {
    if (options?.disable_notification) return {
      message_id: 9000, date: 0, chat: { id: 99, type: "private", first_name: "Owner" }, text,
    };
    requests.push({ chat_id, text, message_thread_id: options?.message_thread_id });
    return {
      message_id: requests.length, date: 0,
      chat: { id: 99, type: "private", first_name: "Owner" }, text,
    };
  });
  t.mock.method(Api.prototype, "editMessageText", async () => true as const);
  const gateway = telegramGateway({ ...f.config, telegramToken: "test-only", telegramChat: "99" }, bot)!;
  const assistant = await f.open(gateway.send);
  try {
    gateway.start(assistant);
    const reply = "Reply text. ".repeat(400);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    f.faux.setResponses([
      async () => { await waiting; return fauxAssistantMessage(reply); },
      // Requested detail can stay long after the native brevity check; transport must still chunk it.
      fauxAssistantMessage(reply),
    ]);
    const incoming = (owner: number, text: string, update_id: number) => ({
      update_id,
      message: {
        message_id: update_id, date: 0, text, message_thread_id: 333,
        chat: { id: owner, type: "private" as const, first_name: "Owner" },
        from: { id: owner, is_bot: false, first_name: "Owner" },
      },
    });
    await bot.handleUpdate(incoming(100, "Unauthorized", 1));
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(actions.length, 0);
    await bot.handleUpdate(incoming(99, "Give me a full detailed report.", 2));
    assert.equal(actions.length, 1);
    await pause(4100);
    assert.ok(actions.length >= 2, "Presence renews during a long request");
    assert.ok(actions.every((a) => String(a.chat) === "99" && a.thread === 333));
    release();
    for (let i = 0; i < 150 && requests.length < 2; i++) await pause(10);
    assert.equal(requests.length, 2);
    assert.equal(requests.map((request) => request.text).join(""), reply);
    assert.ok(requests.every((request) =>
      String(request.chat_id) === "99" && request.message_thread_id === 333));
    const completedActions = actions.length;
    await pause(4100);
    assert.equal(actions.length, completedActions, "Presence stops after completion");
    await bot.handleUpdate(incoming(99, "/stop", 3));
    assert.equal(requests[2].message_thread_id, 333);
    assert.ok(requests[2].text.includes("Stopped"));
  } finally {
    await gateway.stop();
    await assistant.close();
    await f.cleanup();
  }
});

test("one model stream serves multiple conversations, including cancellation while queued", async () => {
  const faux = fauxProvider();
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  let active = 0;
  let peak = 0;
  faux.setResponses([
    async () => {
      peak = Math.max(peak, ++active);
      started();
      await waiting;
      active--;
      return fauxAssistantMessage("First");
    },
    async () => {
      peak = Math.max(peak, ++active);
      active--;
      return fauxAssistantMessage("Third");
    },
  ]);
  const serial = singleStream(faux.provider);
  const model = faux.getModel();
  const transcript = normalizeContext({ messages: [] });
  const first = serial.streamSimple(model, transcript);
  await firstStarted;
  const abort = new AbortController();
  const second = serial.stream(model, transcript, { signal: abort.signal });
  const third = serial.streamSimple(model, transcript);
  abort.abort();
  const stopped = await Promise.race([
    second.result(), pause(500).then(() => { throw new Error("Queued cancellation stalled"); }),
  ]);
  assert.equal(stopped.stopReason, "error");
  assert.equal(faux.state.callCount, 1);
  release();
  await Promise.all([first.result(), third.result()]);
  assert.equal(faux.state.callCount, 2);
  assert.equal(peak, 1);
});

test("Pi reasoning controls reach llama.cpp, refresh local models, and survive restart", async (t) => {
  const f = await fixture();
  const requests: { model: string; chat_template_kwargs: Record<string, unknown>; thinking_budget_tokens?: number; max_tokens: number }[] = [];
  let catalog = ["bonsai-27b"];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/models"))
      return Response.json({ data: catalog.map((id) => ({ id })) });
    if (url.pathname === "/props") return Response.json({ modalities: { vision: true } });
    assert.ok(url.pathname.endsWith("/chat/completions"));
    requests.push(JSON.parse(String(init?.body)));
    const chunks = [
      { id: "test-reply", choices: [{ index: 0, delta: { role: "assistant", content: "READY" }, finish_reason: null }] },
      { id: "test-reply", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const models = await localModels(f.config);
  assert.ok(models.getModel("local", "bonsai-27b")?.input.includes("image"));
  const open = () => openAssistant(f.config, { models });
  let assistant = await open();
  let adapter = await tuiAdapter(assistant, f.config);
  try {
    assert.equal(agentOf(adapter.source.current().conversation).thinkingLevel, "low");
    for (const level of ["low", "medium", "xhigh", "off"]) {
      assert.equal(agentOf(adapter.source.current().conversation).thinkingLevel, level);
      assert.equal((await (await assistant.submit("Reply READY.")).wait(context)).status, "done");
      assert.deepEqual(requests.at(-1)?.chat_template_kwargs, level === "off"
        ? { enable_thinking: false }
        : { enable_thinking: true, reasoning_effort: level });
      assert.equal(requests.at(-1)?.thinking_budget_tokens,
        ({ low: 512, medium: 2048, xhigh: 6144, off: undefined })[level]);
      if (level !== "off") assert.ok(requests.at(-1)!.max_tokens - requests.at(-1)!.thinking_budget_tokens! >= 1024);
      await adapter.controller.cycleThinking();
    }
    assert.equal(agentOf(adapter.source.current().conversation).thinkingLevel, "low");
    catalog = ["bonsai-27b", "second-local-model"];
    await adapter.controller.refreshModels();
    assert.equal(adapter.source.current().models.length, 2);
    assert.ok(adapter.source.current().models.every((model) => model.provider === "local"));
    await adapter.controller.setModel({ provider: "local", modelId: "second-local-model" });
    await adapter.controller.cycleThinking();
    const topic = await assistant.telegramConversation(404);
    await adapter.controller.switchConversation(topic.id);
    assert.equal(agentOf(adapter.source.current().conversation).thinkingLevel, "low");
    await adapter.controller.cycleThinking();
    adapter.dispose();
    await assistant.close();
    assistant = await open();
    adapter = await tuiAdapter(assistant, f.config);
    assert.equal(agentOf(adapter.source.current().conversation).thinkingLevel, "medium");
    assert.equal(agentOf(adapter.source.current().conversation).model?.modelId, "second-local-model");
    await adapter.controller.switchConversation(topic.id);
    assert.equal(agentOf(adapter.source.current().conversation).thinkingLevel, "medium");
    assert.equal((await (await assistant.submit("Reply READY.")).wait(context)).status, "done");
    assert.equal(requests.at(-1)?.model, "second-local-model");
  } finally {
    adapter.dispose();
    await assistant.close();
    await f.cleanup();
  }
});
