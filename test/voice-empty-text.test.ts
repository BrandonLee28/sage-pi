import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("speech worker skips normalized-empty phrases, continues speech, and reports real failures", { timeout: 10000 }, async (t) => {
  if (spawnSync("python3", ["--version"]).error) return t.skip("Python is not installed");
  const directory = await mkdtemp(join(tmpdir(), "sage-empty-speech-"));
  // Model-free reproduction of ptts 0.4.0's normalization error; use the real worker.
  const shim = `
import sys, types, runpy
from contextlib import nullcontext
class PCM:
    def __len__(self): return 1
    def __getitem__(self, _): return self
    def astype(self, _): return self
    def tobytes(self): return bytes(4)
class Audio:
    sample_rate = 24000
    def __iter__(self): return iter([PCM()])
class TTS:
    def __init__(self, *args, **kwargs): pass
    def stream(self, text, **kwargs):
        if not text.strip(): raise RuntimeError('blank text reached model')
        if text in ('🎂', '👩‍💻', '---', '…'):
            raise ValueError('nothing to synthesize: the text is empty')
        if text == 'broken': raise ValueError('model failure')
        return nullcontext(Audio())
sys.modules['numpy'] = types.SimpleNamespace()
sys.modules['ptts'] = types.SimpleNamespace(TTS=TTS)
sys.modules['webrtcvad'] = types.SimpleNamespace(Vad=lambda _: None)
sys.modules['sherpa_onnx'] = types.SimpleNamespace(OfflineRecognizer=types.SimpleNamespace(from_transducer=lambda **kwargs: None))
sys.argv = [sys.argv[1], '--tts-model', 'fixture', '--asr-model', sys.argv[2], '--cache-dir', sys.argv[2]]
runpy.run_path(sys.argv[0], run_name='__main__')
`;
  for (const name of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"])
    await writeFile(join(directory, name), "fixture");
  const child = spawn("python3", ["-u", "-c", shim, fileURLToPath(new URL("../scripts/voice-worker.py", import.meta.url)), directory]);
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const events: { type: string; message?: string }[] = [];
  try {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.type === "ready") {
        for (const text of ["", " \n", "🎂", "👩‍💻", "---", "…", "Hello 🎂", "broken", "Still speaking."])
          child.stdin.write(JSON.stringify({ type: "speak", epoch: 0, text }) + "\n");
        child.stdin.write(JSON.stringify({ type: "finish", epoch: 0 }) + "\n");
      } else events.push(event);
      if (event.type === "audio_end") break;
    }
    assert.equal(events.filter((event) => event.type === "audio").length, 2, stderr);
    assert.deepEqual(events.filter((event) => event.type === "error"),
      [{ type: "error", message: "Speech generation failed: model failure" }]);
    assert.equal(events.at(-1)?.type, "audio_end");
  } finally {
    child.kill(); lines.close();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", () => resolve());
    });
    await rm(directory, { recursive: true, force: true });
  }
});
