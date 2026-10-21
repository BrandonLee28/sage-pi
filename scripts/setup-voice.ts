import { spawnSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../src/config.ts";

if (process.platform !== "darwin") throw new Error("The local voice prototype currently supports macOS.");
const directory = join(process.env.VOICE_DATA_DIR ?? join(readConfig().dataDir, "voice"), "runtime");
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
console.log("Voice bindings installed. FFmpeg and FFplay are also required: brew install ffmpeg");
console.log("Accept the Phonon 40M model terms, then sign in: uvx --from huggingface-hub hf auth login");
console.log("Or download config.json, tokenizer.json, model.q8.gguf and default-voice.safetensors into one folder, then set VOICE_TTS_MODEL to that folder.");
console.log("Start Sage locally, use headphones, and enter /speak. Models download on first use; microphone starts only after models are ready.");
