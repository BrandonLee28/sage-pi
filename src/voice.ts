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

export type VoiceStatus = {
  phase: "loading" | "calibrating" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking";
  level: number; progress?: number; detail?: string;
};
export type VoiceEvent = { type: "ready" | "calibrating" | "calibrated" | "level" | "speech_start" | "speech_end" | "speech_discarded" | "transcript" | "audio" | "audio_end" | "error";
  id?: number; epoch?: number; text?: string; pcm?: string; sampleRate?: number;
  endedAt?: number; asrDoneAt?: number; message?: string; value?: number };

export function localVoice(config: Config, events: (event: VoiceEvent) => void) {
  const directory = process.env.VOICE_DATA_DIR ?? join(config.dataDir, "voice");
  const python = process.env.VOICE_PYTHON ?? join(directory, "runtime", "bin", "python");
  const silence = Number(process.env.VOICE_SILENCE_MS ?? 400);
  if (!Number.isInteger(silence) || silence < 200 || silence > 2000 || silence % 20)
    throw new Error("VOICE_SILENCE_MS must be a multiple of 20 between 200 and 2000.");
  let worker: ChildProcessWithoutNullStreams | undefined;
  let device: ChildProcessWithoutNullStreams | undefined;
  let closed = false, epoch = 0;
  const children = new Set<ChildProcessWithoutNullStreams>();
  const launch = (command: string, args: string[], critical = false) => {
    let stderr = "";
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
      const audio = process.env.VOICE_AUDIO ?? join(directory, "audio");
      await access(audio).catch(() => { throw new Error("Native voice audio is missing. Run npm run voice:setup first."); });
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
            device = launch(audio, [], true);
            createInterface({ input: device.stdout }).on("line", (line) => {
              if (closed) return;
              try {
                const input = JSON.parse(line) as VoiceEvent | { type: "mic"; pcm: string };
                if (input.type === "mic") {
                  if (!send(input)) {
                    device!.stdout.pause();
                    worker?.stdin.once("drain", () => device?.stdout.resume());
                  }
                } else if (input.type !== "audio_end" || input.epoch === epoch) events(input);
              } catch { events({ type: "error", message: "Invalid native audio output." }); }
            });
            return;
          }
          if ((message.type === "audio" || message.type === "audio_end") && message.epoch !== epoch) return;
          if (message.type === "audio" || message.type === "audio_end") {
            if (message.type === "audio" && (message.sampleRate !== 24000 || !message.pcm))
              throw new Error("Unexpected speech audio format.");
            if (!device?.stdin.write(JSON.stringify(message) + "\n")) {
              worker!.stdout.pause();
              device?.stdin.once("drain", () => worker?.stdout.resume());
            }
            if (message.type === "audio_end") return; // Native playback, not synthesis, owns completion.
          }
          events(message);
        } catch (error) { events({ type: "error", message: `Voice worker: ${error instanceof Error ? error.message : "invalid output"}` }); }
      });
    },
    speak(text: string) { if (!closed) send({ type: "speak", epoch, text }); },
    finish() { if (!closed) send({ type: "finish", epoch }); },
    interrupt() {
      epoch++;
      send({ type: "cancel", epoch });
      device?.stdin.write(JSON.stringify({ type: "cancel", epoch }) + "\n");
      worker?.stdout.resume();
    },
    stop() {
      closed = true;
      for (const child of children) child.kill();
      worker = device = undefined;
    },
  };
}
