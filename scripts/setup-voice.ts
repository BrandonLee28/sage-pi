import { spawnSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientDataDir } from "../src/settings.ts";

if (process.platform !== "darwin") throw new Error("The local voice prototype currently supports macOS.");
const assets = process.env.VOICE_DATA_DIR ?? join(clientDataDir(), "voice");
const directory = join(assets, "runtime");
await mkdir(directory, { recursive: true });
const exists = await access(join(directory, "bin", "python")).then(() => true, () => false);
for (const args of [
  ...(!exists ? [["venv", "--python", "3.13", directory]] : []),
  ["pip", "install", "--python", join(directory, "bin", "python"), "-r", fileURLToPath(new URL("voice-requirements.txt", import.meta.url))],
]) {
  const result = spawnSync("uv", args, { stdio: "inherit" });
  if (result.error) throw new Error("Install uv first: brew install uv");
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!process.env.VOICE_ASR_MODEL) {
  const model = spawnSync(join(directory, "bin", "python"),
    [fileURLToPath(new URL("setup-voice-model.py", import.meta.url)), assets], { stdio: "inherit" });
  if (model.error) throw model.error;
  if (model.status !== 0) process.exit(model.status ?? 1);
}
const compiled = spawnSync("xcrun", ["swiftc", "-O", "-module-cache-path", join(assets, "swift-cache"),
  fileURLToPath(new URL("voice-audio.swift", import.meta.url)), "-o", join(assets, "audio")], { stdio: "inherit" });
if (compiled.error) throw new Error("Install Apple's Command Line Tools first: xcode-select --install");
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
console.log("Voice bindings and native macOS echo cancellation installed.");
console.log("Accept the Phonon 40M model terms, then sign in: uvx --from huggingface-hub hf auth login");
console.log("Or download config.json, tokenizer.json, model.q8.gguf and default-voice.safetensors into one folder, then set VOICE_TTS_MODEL to that folder.");
console.log("Parakeet Unified English 0.6B recognition is ready. Start Sage and enter /speak; stay quiet for the two-second room calibration.");
