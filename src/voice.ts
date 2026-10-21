import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Config } from "./config.ts";

/** Feed only model text, never thinking or tool arguments. Bound chunks to limit queued speech. */
export class SpokenPhrases {
  private pending = "";
  private code = false;
  push(text: string, final = false): string[] {
    this.pending += text;
    const phrases: string[] = [];
    for (;;) {
      const sentence = this.pending.match(/[.!?](?:["')\]]*)\s|\n/u);
      const boundary = sentence && sentence.index! + sentence[0].length <= 180
        ? sentence : this.pending.match(/.{100,180}\s/u);
      if (!boundary && !final) break;
      const size = boundary ? boundary.index! + boundary[0].length : this.pending.length;
      if (!size) break;
      const part = this.pending.slice(0, size);
      this.pending = this.pending.slice(size);
      const spoken = part.split("```").map((piece, index, parts) => {
        const value = this.code ? "" : piece;
        if (index < parts.length - 1) this.code = !this.code;
        return value;
      }).join("").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "link")
        .replace(/[*_`#]/g, "").trim();
      if (spoken) phrases.push(spoken);
      if (!this.pending) break;
    }
    return phrases;
  }
}

export type VoiceEvent = { type: "ready" | "speech_start" | "speech_end" | "transcript" | "audio" | "audio_end" | "error";
  id?: number; epoch?: number; text?: string; pcm?: string; sampleRate?: number;
  endedAt?: number; asrDoneAt?: number; message?: string };

export function localVoice(config: Config, events: (event: VoiceEvent) => void) {
  const directory = process.env.VOICE_DATA_DIR ?? join(config.dataDir, "voice");
  const python = process.env.VOICE_PYTHON ?? join(directory, "runtime", "bin", "python");
  const silence = Number(process.env.VOICE_SILENCE_MS ?? 400);
  if (!Number.isInteger(silence) || silence < 200 || silence > 2000 || silence % 20)
    throw new Error("VOICE_SILENCE_MS must be a multiple of 20 between 200 and 2000.");
  let worker: ChildProcessWithoutNullStreams | undefined;
  let microphone: ChildProcessWithoutNullStreams | undefined;
  let player: ChildProcessWithoutNullStreams | undefined;
  let closed = false, epoch = 0, stderr = "";
  const children = new Set<ChildProcessWithoutNullStreams>();
  const launch = (command: string, args: string[], critical = false) => {
    const child = spawn(command, args, { stdio: "pipe", env: process.env });
    children.add(child);
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-3000); });
    child.stdin.on("error", () => {}); // An interrupted audio pipe can close before its last queued write.
    child.on("error", (error) => { if (!closed) events({ type: "error", message: `${command}: ${error.message}` }); });
    child.on("close", (code, signal) => {
      children.delete(child);
      if (!closed && (critical || code !== 0) && signal !== "SIGTERM")
        events({ type: "error", message: `${command} exited (${code}): ${stderr.slice(-1200)}` });
    });
    return child;
  };
  const send = (message: object) => worker?.stdin.write(JSON.stringify(message) + "\n");
  return {
    async start() {
      if (process.platform !== "darwin") throw new Error("The local voice prototype currently supports macOS. Run it on the Mac with your microphone, not over SSH.");
      await access(python).catch(() => { throw new Error("Voice runtime is missing. Run npm run voice:setup first."); });
      await mkdir(directory, { recursive: true });
      if (closed) return;
      const args = ["-u", fileURLToPath(new URL("../scripts/voice-worker.py", import.meta.url)),
        "--tts-model", process.env.VOICE_TTS_MODEL ?? "hf://gradium/phonon-40m-en",
        "--asr-model", process.env.VOICE_ASR_MODEL ?? "base.en", "--cache-dir", directory,
        "--silence-ms", String(silence), "--voice", process.env.VOICE_TTS_VOICE ?? ""];
      worker = launch(python, args, true);
      const lines = createInterface({ input: worker.stdout });
      lines.on("line", (line) => {
        if (closed) return;
        try {
          const message = JSON.parse(line) as VoiceEvent;
          if (message.type === "ready") {
            microphone = launch(process.env.VOICE_FFMPEG ?? "ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error",
              "-f", "avfoundation", "-i", `:${process.env.VOICE_MIC ?? "default"}`,
              "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"], true);
            microphone.stdout.on("data", (pcm: Buffer) => {
              if (!send({ type: "mic", pcm: pcm.toString("base64") })) {
                microphone?.stdout.pause();
                worker?.stdin.once("drain", () => microphone?.stdout.resume());
              }
            });
          }
          if ((message.type === "audio" || message.type === "audio_end") && message.epoch !== epoch) return;
          if (message.type === "audio") {
            if (message.sampleRate !== 24000 || !message.pcm) throw new Error("Unexpected speech audio format.");
            if (!player) player = launch(process.env.VOICE_FFPLAY ?? "ffplay", ["-nodisp", "-autoexit", "-loglevel", "error",
              "-f", "f32le", "-ar", "24000", "-ac", "1", "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0"]);
            if (!player.stdin.write(Buffer.from(message.pcm, "base64"))) {
              worker!.stdout.pause();
              player.stdin.once("drain", () => worker?.stdout.resume());
            }
          }
          if (message.type === "audio_end") { player?.stdin.end(); player = undefined; }
          events(message);
        } catch (error) { events({ type: "error", message: `Voice worker: ${error instanceof Error ? error.message : "invalid output"}` }); }
      });
    },
    speak(text: string) { if (!closed) send({ type: "speak", epoch, text }); },
    finish() { if (!closed) send({ type: "finish", epoch }); },
    interrupt() {
      epoch++;
      send({ type: "cancel", epoch });
      // Include players whose stdin ended but whose buffered audio is still playing.
      for (const child of children) if (child !== worker && child !== microphone) child.kill();
      player = undefined;
      worker?.stdout.resume();
    },
    stop() {
      closed = true;
      for (const child of children) child.kill();
      worker = microphone = player = undefined;
    },
  };
}
