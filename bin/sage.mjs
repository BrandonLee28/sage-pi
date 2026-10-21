#!/usr/bin/env node
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

// Only explicit server commands load server credentials. Mac startup is always a client.
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
if (["gateway", "--headless", "model", "mcp", "doctor"].includes(process.argv[2])) {
  try { loadEnvFile(".env"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
await import("../src/cli.ts");
