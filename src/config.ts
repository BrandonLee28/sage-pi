import { resolve } from "node:path";
import { readSettings } from "./settings.ts";

function integer(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}

export function readConfig() {
  const dataDir = resolve(process.env.DATA_DIR ?? "./data");
  const settings = readSettings(dataDir);
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const telegramChat = process.env.TELEGRAM_CHAT_ID ?? "";
  if (Boolean(telegramToken) !== Boolean(telegramChat))
    throw new Error("Set both Telegram settings, or neither.");
  const timezone = process.env.TZ ?? "America/New_York";
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  const contextWindow = integer("LLM_CONTEXT", 65536, 8192, 2000000);
  const maxTokens = integer("LLM_MAX_TOKENS", 8192, 128, 32768);
  if (maxTokens >= contextWindow / 2)
    throw new Error("LLM_MAX_TOKENS must be less than half LLM_CONTEXT.");
  return {
    timezone,
    telegramToken,
    telegramChat,
    contextWindow,
    maxTokens,
    dataDir,
    modelRevision: settings.model?.revision,
    mcpServers: settings.mcpServers ?? {},
    baseUrl: (
      settings.model?.baseUrl ?? process.env.LLM_BASE_URL ?? "http://example.invalid:8080/v1"
    ).replace(/\/$/, ""),
    modelId: settings.model?.id ?? process.env.LLM_MODEL ?? "example-model",
    apiKey: process.env.LLM_API_KEY ?? "",
    enableShell: process.env.ENABLE_SHELL !== "false",
    searxngUrl: process.env.SEARXNG_URL ?? "",
    firecrawlUrl: process.env.FIRECRAWL_URL ?? "",
    firecrawlKey: process.env.FIRECRAWL_API_KEY ?? "",
    lightpandaUrl: process.env.LIGHTPANDA_URL ?? "",
    appleId: process.env.APPLE_ID ?? "",
    appleAppPassword: process.env.APPLE_APP_PASSWORD ?? "",
    appleCalendarUrl: process.env.APPLE_CALENDAR_URL ?? "",
  };
}

export type Config = ReturnType<typeof readConfig>;
