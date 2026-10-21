import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readConfig } from "./config.ts";
import { gatewayUrl, readSettings, saveSettings } from "./settings.ts";

const args = process.argv.slice(2);
const clientDir = process.env.CLIENT_DATA_DIR ?? join(process.env.HOME ?? process.cwd(), ".sage");
if (!args.length && (process.env.GATEWAY_URL || readSettings(clientDir).gateway)) args.push("connect");
if (args[0] === "connect") {
  if (args.length > 2) throw new Error("Usage: sage connect [http://gateway:8787 | --forget]");
  const settings = readSettings(clientDir);
  if (args[1] === "--forget") {
    delete settings.gateway;
    await saveSettings(clientDir, settings);
    console.log("Saved gateway connection removed. Environment overrides still apply.");
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("sage connect needs a local terminal.");
    const target = args[1] || process.env.GATEWAY_URL || settings.gateway?.url;
    if (!target) throw new Error("Connect once with: sage connect http://gateway:8787");
    const url = gatewayUrl(target);
    let token = process.env.GATEWAY_TOKEN || (settings.gateway && gatewayUrl(settings.gateway.url) === url ? settings.gateway.token : "");
    let prompted = false;
    if (!token) {
      const { SageHeader, registerSageTheme, textPrompt } = await import("./cli-ui.ts");
      registerSageTheme();
      token = await textPrompt(new SageHeader({ section: "Gateway", cwd: url }), "Gateway token (hidden; Esc cancels)", true) ?? "";
      if (!token) process.exit(0);
      prompted = true;
    }
    if (token.length < 32 || /\s/.test(token)) throw new Error("Gateway token must contain at least 32 non-whitespace characters.");
    // The client never opens Pi storage, reads server settings, or starts Telegram/MCP.
    process.env.PI_CODING_AGENT_DIR = join(clientDir, "pi");
    const [{ connectGateway }, { runDurableTui }, { SettingsManager }] = await Promise.all([
      import("./gateway-client.ts"), import("../vendor/pi-durable-tui/tui.ts"),
      import("../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js"),
    ]);
    const remote = await connectGateway(url, token, clientDir);
    try {
      // Save only after authentication succeeds. Never reuse a saved token for another origin.
      if (args[1] || prompted) await saveSettings(clientDir, { ...settings, gateway: { url, token } });
      await runDurableTui(remote.source, remote.controller, SettingsManager.inMemory());
    }
    finally { await remote.dispose(); }
  }
} else if (args.length && !(args.length === 1 && ["--headless", "gateway"].includes(args[0]!))) {
  try { await (await import("./manage.ts")).manage(args); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  const { openAssistant } = await import("./assistant.ts");
  const { telegramGateway } = await import("./telegram.ts");
  const { tuiAdapter } = await import("./tui-adapter.ts");

  const gatewayOptions = args[0] === "gateway" ? {
    token: process.env.GATEWAY_TOKEN ?? "", host: process.env.GATEWAY_HOST ?? "127.0.0.1",
    port: Number(process.env.GATEWAY_PORT ?? 8787),
  } : undefined;
  if (gatewayOptions) {
    if (gatewayOptions.token.length < 32 || /\s/.test(gatewayOptions.token)) throw new Error("GATEWAY_TOKEN must contain at least 32 non-whitespace characters.");
    if (!Number.isInteger(gatewayOptions.port) || gatewayOptions.port < 1 || gatewayOptions.port > 65535) throw new Error("Invalid GATEWAY_PORT.");
  }
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

  if (args[0] === "gateway" || args[0] === "--headless") {
    let gateway: { close(): Promise<void> } | undefined;
    if (gatewayOptions) {
      try {
        gateway = await (await import("./gateway.ts")).openGateway(assistant, config, gatewayOptions);
      } catch (error) { await close(); throw error; }
    }
    console.log(
      gateway ? `Sage gateway listening on ${process.env.GATEWAY_HOST ?? "127.0.0.1"}:${process.env.GATEWAY_PORT ?? 8787}.`
        : `Personal Pi running headless (${config.modelId}). No HTTP listener.`,
    );
    telegram?.start(assistant);
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      try { await gateway?.close(); }
      finally { await close(); }
    };
    const stop = () => { void shutdown().catch((error) => { console.error(error); process.exitCode = 1; }); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // A process lifetime, not an inference loop. Pi owns scheduling and execution.
    const keepAlive = setInterval(() => {}, 2147483647);
    try {
      await assistant.harness.closed;
    } finally {
      clearInterval(keepAlive);
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      await gateway?.close();
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
      await adapter.dispose();
      await close();
    }
  }
}
