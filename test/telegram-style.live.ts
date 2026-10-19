// Opt-in real-model style check: disposable workspace, no Telegram or external tools.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, openAssistant } from "../src/assistant.ts";
import { readConfig } from "../src/config.ts";

process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_CHAT_ID = "";
const dataDir = await mkdtemp(join(tmpdir(), "sage-telegram-style-live-"));
const assistant = await openAssistant({
  ...readConfig(), dataDir, enableShell: false, telegramToken: "", telegramChat: "",
  appleId: "", appleAppPassword: "", appleCalendarUrl: "",
  searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "",
}, { sendTelegram: async () => {} });
try {
  await assistant.root.configure({ tools: [] }, context);
  for (const prompt of [
    "hey",
    "huh",
    "what's on my calendar for tmr? For this test, tomorrow is November 2, 2026. " +
      "The complete test agenda is: project check-in, 2–3 pm in room 10; design review, 4–5 pm in room 12. " +
      "Use only this supplied agenda; no lookup is needed.",
    "i'll do the reading after lunch tomorrow instead. then the project check-in, design review, " +
      "errands on the way home and dinner. on tuesday i'll start earlier. does that work?",
  ]) {
    const settled = await (await assistant.submit(prompt)).wait(context);
    assert.equal(settled.status, "done", JSON.stringify(settled));
    const messages = (await assistant.root.context(context)).messages;
    const answer = messages.findLast((message) => message.role === "assistant");
    const text = answer?.role === "assistant" ? answer.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") : "";
    assert.ok(text.trim(), "Model must produce a visible reply");
    console.log(`User: ${prompt}\nSage: ${text}\n`);
    assert.doesNotMatch(text, /\*\*|```|^#{1,6} /m, "Reply must not contain Markdown formatting");
    if (prompt.startsWith("i'll")) {
      assert.ok(text.trim().split(/\s+/u).length <= 60, "An ordinary planning reply should be concise");
    }
    if (prompt.startsWith("what's")) {
      assert.match(text, /project check-in/i);
      assert.match(text, /design review/i);
      assert.match(text, /room 10/i);
      assert.match(text, /room 12/i);
    }
  }
  console.log("PASS: real-model replies are plain text, preserve the test agenda, and keep the ordinary planning reply brief. Review printed wording for tone.");
} finally {
  await assistant.close();
  await rm(dataDir, { recursive: true, force: true });
}
