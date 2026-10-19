import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readConfig } from "./config.ts";

const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && args[0] === "--headless")) {
  try { await (await import("./manage.ts")).manage(args); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  const { openAssistant } = await import("./assistant.ts");
  const { telegramGateway } = await import("./telegram.ts");
  const { tuiAdapter } = await import("./tui-adapter.ts");

  const config = readConfig();
  // Keep Pi's terminal preferences under this application's data directory.
  process.env.PI_CODING_AGENT_DIR ??= join(config.dataDir, "pi");
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  const telegram = telegramGateway(config);
  const assistant = await openAssistant(config, { sendTelegram: telegram?.send });
  const close = async () => {
    await telegram?.stop();
    await assistant.close();
  };

  if (process.argv.includes("--headless")) {
    console.log(
      `Personal Pi running headless (${config.modelId}). No HTTP listener.`,
    );
    telegram?.start(assistant);
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    // A process lifetime, not an inference loop. Pi owns scheduling and execution.
    const keepAlive = setInterval(() => {}, 2147483647);
    try {
      await assistant.harness.closed;
    } finally {
      clearInterval(keepAlive);
    }
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      await close();
      throw new Error(
        "The Pi TUI needs a terminal. Use npm start in a terminal, or --headless for background operation.",
      );
    }
    const { SettingsManager } = await import(
      "../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js"
    );
    const { runDurableTui } = await import("../vendor/pi-durable-tui/tui.ts");
    const adapter = await tuiAdapter(assistant, config);
    const settings = SettingsManager.inMemory();
    telegram?.start(assistant);
    try {
      await runDurableTui(adapter.source, adapter.controller, settings);
    } finally {
      adapter.dispose();
      await close();
    }
  }
}
