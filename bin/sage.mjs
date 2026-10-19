#!/usr/bin/env node
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

// Resolve configuration beside this checkout even when invoked from another directory.
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
try { loadEnvFile(".env"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await import("../src/cli.ts");
