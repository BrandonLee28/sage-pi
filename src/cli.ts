import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { clientDataDir, gatewayUrl, httpUrl, readSettings, saveSettings } from "./settings.ts";

const args = process.argv.slice(2);
const clientDir = clientDataDir();
if (!args.length || (args.length === 1 && args[0] === "setup")) args.splice(0, args.length, "connect");
if (args[0] === "voice") {
  if (args.length !== 3 || args[1] !== "model" || !args[2]?.trim())
    throw new Error("Usage: sage voice model /path/to/phonon-40m-en (or hf://gradium/phonon-40m-en)");
  const ttsModel = args[2].startsWith("hf://") ? args[2] : resolve(args[2]);
  if (!ttsModel.startsWith("hf://")) {
    for (const file of ["config.json", "tokenizer.json", "model.q8.gguf", "default-voice.safetensors"])
      await access(join(ttsModel, file)).catch(() => { throw new Error(`Voice model is missing ${file} in ${ttsModel}.`); });
  }
  await saveSettings(clientDir, { ...readSettings(clientDir), voice: { ttsModel } });
  console.log(`Mac voice model saved: ${ttsModel}. Restart Sage, then enter /speak.`);
} else if (args[0] === "connect") {
  if (args.length > 2) throw new Error("Usage: sage connect [http://gateway:8787 | --forget]");
  const settings = readSettings(clientDir);
  if (args[1] === "--forget") {
    delete settings.gateway;
    await saveSettings(clientDir, settings);
    console.log("Saved gateway connection removed. Environment overrides still apply.");
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("sage connect needs a local terminal.");
    let target = args[1] || process.env.GATEWAY_URL || settings.gateway?.url;
    if (!target) {
      const { SageHeader, registerSageTheme, textPrompt } = await import("./cli-ui.ts");
      registerSageTheme();
      target = await textPrompt(new SageHeader({ section: "Gateway" }), "Gateway URL (for example http://your-umbrel:8787)");
      if (!target) process.exit(0);
    }
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
} else if (args.length === 1 && ["gateway", "--headless"].includes(args[0]!)) {
  // Only an explicit server command may open the workspace, database, or services.
  const options = {
    token: process.env.GATEWAY_TOKEN ?? "", host: process.env.GATEWAY_HOST ?? "127.0.0.1",
    port: Number(process.env.GATEWAY_PORT ?? 8787),
  };
  if (options.token.length < 32 || /\s/.test(options.token)) throw new Error("GATEWAY_TOKEN must contain at least 32 non-whitespace characters.");
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("Invalid GATEWAY_PORT.");
  const [{ openAssistant }, { telegramGateway }, { readConfig }, { openGateway }] = await Promise.all([
    import("./assistant.ts"), import("./telegram.ts"), import("./config.ts"), import("./gateway.ts"),
  ]);
  const config = readConfig();
  if (!config.baseUrl.trim() || !config.modelId.trim())
    throw new Error("Configure LLM_BASE_URL and LLM_MODEL, or use sage model MODEL_ID --url URL before starting the gateway.");
  httpUrl(config.baseUrl);
  process.env.PI_CODING_AGENT_DIR ??= join(config.dataDir, "pi");
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  const telegram = telegramGateway(config);
  const assistant = await openAssistant(config, { sendTelegram: telegram?.send });
  const close = async () => {
    try { await telegram?.stop(); }
    finally { await assistant.close(); }
  };
  let gateway: Awaited<ReturnType<typeof openGateway>>;
  try { gateway = await openGateway(assistant, config, options); }
  catch (error) { await close(); throw error; }
  console.log(`Sage gateway listening on ${options.host}:${options.port}.`);
  telegram?.start(assistant);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await gateway.close(); }
    finally { await close(); }
  };
  const stop = () => { void shutdown().catch((error) => { console.error(error); process.exitCode = 1; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await assistant.harness.closed; }
  finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await gateway.close();
  }
} else {
  try { await (await import("./manage.ts")).manage(args); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
