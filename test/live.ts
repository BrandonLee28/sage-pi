// Explicit opt-in: uses the configured local model, with an isolated temporary database/workspace.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, openAssistant } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";
import { agentOf, tuiAdapter } from "../src/tui-adapter.ts";
import { Routines } from "../extensions/routines.ts";
import { redPng } from "./fixtures.ts";

// Ignore even partially entered Telegram setup; live tests must never use it.
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_CHAT_ID = "";
process.env.APPLE_ID = "";
process.env.APPLE_APP_PASSWORD = "";
const configured = readConfig();
const testWeb = process.argv.includes("--web");
const config = {
  ...configured,
  dataDir: await mkdtemp(join(tmpdir(), "personal-pi-live-")),
  telegramToken: "",
  telegramChat: "",
  searxngUrl: testWeb ? configured.searxngUrl : "",
  firecrawlUrl: testWeb ? configured.firecrawlUrl : "",
  lightpandaUrl: "",
  enableShell: true,
};
const deliveries: { text: string; threadId?: number }[] = [];
const open = () => openAssistant(config, {
  // A simulated sender only: this test never contacts Telegram.
  sendTelegram: async (text, threadId) => { deliveries.push({ text, threadId }); },
});
let assistant = await open();
try {
  console.log(`Testing ${config.modelId} at ${config.baseUrl}`);
  const saved = await (
    await assistant.submit(
      'Use the memory tool now to save key test/favorite-color with text "My favorite color is teal." and source "live test". Do not pin it. Then reply in one sentence.',
      "live-memory",
    )
  ).wait(context);
  assert.equal(saved.status, "done", JSON.stringify(saved));
  assert.ok(
    (await assistant.personalState()).memories.some(
      (m) => m.key === "test/favorite-color",
    ),
  );
  console.log("PASS: real model called a tool and persisted memory.");
  await assistant.close();
  assistant = await open();
  const recalled = await (
    await assistant.submit(
      'Use memory search for "favorite". What is my favorite color? One sentence.',
      "live-recall",
    )
  ).wait(context);
  assert.equal(recalled.status, "done", JSON.stringify(recalled));
  const entries = await assistant.root.entries({}, 50, undefined, context);
  assert.ok(
    entries.items.some((e) =>
      e.model?.some(
        (m) =>
          m.role === "toolResult" &&
          m.toolName === "memory" &&
          JSON.stringify(m.content).includes("teal"),
      ),
    ),
  );
  console.log("PASS: memory retrieval after restart.");
  const shell = await (
    await assistant.submit(
      "Call bash with exactly this command: printf pi-native-tools-ok . Report the output briefly.",
      "live-shell",
    )
  ).wait(context);
  assert.equal(shell.status, "done", JSON.stringify(shell));
  const afterShell = await assistant.root.entries({}, 50, undefined, context);
  assert.ok(
    afterShell.items.some((e) =>
      e.model?.some(
        (m) =>
          m.role === "toolResult" &&
          m.toolName === "bash" &&
          JSON.stringify(m.content).includes("pi-native-tools-ok"),
      ),
    ),
  );
  console.log("PASS: Pi native shell tool works with the real model.");
  for (const [enabled, tool, prompt] of [
    [config.searxngUrl, "web_search", 'Use web_search to search for "Pi Durable Earendil". Briefly name one result.'],
    [config.firecrawlUrl, "web_extract", 'Use web_extract to read https://example.com . Summarize the returned page in one sentence.'],
  ]) {
    if (!enabled) continue;
    const result = await (await assistant.submit(prompt, `live-${tool}`)).wait(context);
    assert.equal(result.status, "done", JSON.stringify(result));
    const view = await assistant.root.context(context);
    const output = view.messages.findLast((message) =>
      message.role === "toolResult" && message.toolName === tool,
    );
    assert.ok(output?.role === "toolResult", `Model did not call ${tool}`);
    assert.ok(!output.isError, JSON.stringify(output));
    assert.ok(JSON.stringify(output.content).length > 30);
    console.log(`PASS: real model used ${tool} with your configured service.`);
  }
  if (process.argv.includes("--topics")) {
    const topic = await assistant.telegramConversation(9001);
    const result = await (await assistant.submit(
      'Use memory search for "favorite" and tell me my favorite color in one sentence.',
      "live-topic", true, true, topic,
    )).wait(context);
    assert.equal(result.status, "done", JSON.stringify(result));
    for (let i = 0; i < 100 && deliveries.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(deliveries[0]?.threadId, 9001);
    assert.ok(deliveries[0].text.toLowerCase().includes("teal"));
    assert.ok(!JSON.stringify((await topic.context(context)).messages)
      .includes("pi-native-tools-ok"));
    console.log("PASS: real model used shared memory from a fresh topic; simulated delivery retained its topic.");
  }
  if (process.argv.includes("--reasoning")) {
    const adapter = await tuiAdapter(assistant, config);
    try {
      for (const level of ["low", "medium", "xhigh", "off"]) {
        assert.equal(agentOf(adapter.source.current().conversation).thinkingLevel, level);
        const settled = await (await assistant.submit("Reply only READY.")).wait(context);
        assert.equal(settled.status, "done", JSON.stringify(settled));
        console.log(`PASS: real llama.cpp completion with thinking ${level}.`);
        await adapter.controller.cycleThinking();
      }
    } finally {
      adapter.dispose();
    }
  }
  if (process.argv.includes("--recall")) {
    const topic = await assistant.telegramConversation(9010);
    const recalled = await (await assistant.submit(
      'Use recall search with query "favorite color" to find the original discussion in another conversation. ' +
      'Then use recall read with a returned conversationId and entryId. Tell me the color in one sentence. Do not use memory.',
      "live-transcript-recall", false, true, topic,
    )).wait(context);
    assert.equal(recalled.status, "done", JSON.stringify(recalled));
    const topicEntries = await topic.entries({}, 100, undefined, context);
    const recallResults = topicEntries.items.flatMap((entry) => entry.model ?? []).filter((m) =>
      m.role === "toolResult" && m.toolName === "recall" && !m.isError);
    assert.ok(recallResults.some((m) => JSON.stringify(m.content).includes("teal")));
    assert.ok(recallResults.some((m) => JSON.stringify(m.content).includes("entries")));
    console.log("PASS: real model searched and opened another conversation's original history.");
  }
  if (process.argv.includes("--media-routines")) {
    await writeFile(join(assistant.workspace, "test-photo.png"), redPng());
    const photo = await (await assistant.submit(
      "Use read on test-photo.png and tell me its dominant color. One sentence.", "live-photo",
    )).wait(context);
    assert.equal(photo.status, "done");
    const photoView = await assistant.root.context(context);
    assert.ok(photoView.messages.some((m) => m.role === "toolResult" && m.content.some((p) => p.type === "image")));
    const answer = photoView.messages.findLast((m) => m.role === "assistant");
    assert.ok(answer?.role === "assistant" && answer.content.some((p) => p.type === "text" && /red/i.test(p.text)));
    console.log("PASS: real model inspected a photo through Pi's native image tool.");
    const routine = await (await assistant.submit(
      "Set up a recurring routine called live-morning-check: every weekday at 8 AM America/New_York, " +
      "ask me which assignment I will work on first. Use the routine tool to save it, then confirm the next run briefly.",
      "live-routine",
    )).wait(context);
    assert.equal(routine.status, "done");
    const state = await assistant.harness.snapshot(Routines, context);
    assert.ok(Object.values(state?.items ?? {}).some((item) => item.cron === "0 8 * * 1-5" &&
      item.timezone === "America/New_York" && item.nextAt! > Date.now()));
    console.log("PASS: real model created a recurring routine from ordinary chat in the disposable workspace.");
  }
} finally {
  await assistant.close();
  await rm(config.dataDir, { recursive: true, force: true });
}
