import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.ts";
import { openAssistant } from "../src/assistant.ts";
import { tuiAdapter } from "../src/tui-adapter.ts";
import { runDurableTui } from "../vendor/pi-durable-tui/tui.ts";
import { SettingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run voice:try in a local Mac terminal.");
const configured = readConfig();
process.env.VOICE_DATA_DIR ??= join(configured.dataDir, "voice");
const dataDir = await mkdtemp(join(tmpdir(), "sage-voice-trial-"));
// A disposable chat with the configured LLM. No Telegram, account tools, shell, or configured MCP processes.
let assistant: Awaited<ReturnType<typeof openAssistant>> | undefined;
let adapter: Awaited<ReturnType<typeof tuiAdapter>> | undefined;
try {
  assistant = await openAssistant({ ...configured, dataDir, mcpServers: {}, enableShell: false,
    telegramToken: "", telegramChat: "", searxngUrl: "", firecrawlUrl: "", lightpandaUrl: "",
    appleId: "", appleAppPassword: "", appleCalendarUrl: "" });
  adapter = await tuiAdapter(assistant, { ...configured, dataDir });
  void adapter.controller.submit("/speak", "steer");
  await runDurableTui(adapter.source, adapter.controller, SettingsManager.inMemory());
} finally {
  try { await adapter?.dispose(); }
  finally {
    try { await assistant?.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  }
}
