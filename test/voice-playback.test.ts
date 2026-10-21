import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

test("speech worker paces long replies to playback, accepts text bursts, and interrupts while waiting", { timeout: 15000 }, async (t) => {
  if (spawnSync("python3", ["--version"]).error) return t.skip("Python is not installed");
  const directory = await mkdtemp(join(tmpdir(), "sage-playback-"));
  // Fake only model bindings. Exercise the real worker's threads, queues, and stdio.
  const shim = `
import sys, types, runpy
from contextlib import nullcontext
class PCM:
    def __init__(self, size): self.size = size
    def __len__(self): return self.size
    def __getitem__(self, part): return PCM(len(range(self.size)[part]))
    def astype(self, _): return self
    def tobytes(self): return bytes(self.size * 4)
class TTS:
    def __init__(self, *args, **kwargs): pass
    def stream(self, text, **kwargs): return nullcontext(Audio())
class Audio:
    sample_rate = 24000
    # One oversized model chunk must still respect the playback window.
    def __iter__(self): return iter([PCM(24000 * 75)])
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
  let stderr = "", chunks = 0, seconds = 0, ready = false, ended = false, acknowledge = false;
  const errors: string[] = [], epochs: number[] = [];
  const send = (value: object) => child.stdin.write(JSON.stringify(value) + "\n");
  child.stderr.on("data", (data) => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const event = JSON.parse(line);
    if (event.type === "ready") ready = true;
    if (event.type === "error") errors.push(event.message);
    if (event.type === "audio") {
      chunks++; epochs.push(event.epoch);
      const frames = Buffer.from(event.pcm, "base64").length / 4;
      assert.ok(frames <= 24000);
      if (acknowledge) {
        seconds += frames / 24000;
        send({ type: "played", epoch: event.epoch, frames });
      }
    }
    if (event.type === "audio_end" && event.epoch === 2) ended = true;
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 500; i++) {
      assert.equal(child.exitCode, null, stderr);
      assert.deepEqual(errors, []);
      if (check()) return;
      await pause(10);
    }
    assert.fail("Playback check timed out: " + stderr);
  };
  try {
    await until(() => ready);
    for (let i = 0; i < 40; i++) send({ type: "speak", epoch: 0, text: "A queued phrase." });
    await until(() => chunks === 5);
    await pause(100);
    assert.equal(chunks, 5, "synthesis waits at five seconds, despite a burst of text");
    send({ type: "cancel", epoch: 1 });
    send({ type: "speak", epoch: 1, text: "Interrupt the blocked turn." });
    await until(() => chunks === 10);
    send({ type: "played", epoch: 0, frames: 24000 * 5 });
    await pause(100);
    assert.equal(chunks, 10, "stale acknowledgments cannot release the new turn's credits");
    acknowledge = true;
    send({ type: "cancel", epoch: 2 });
    send({ type: "speak", epoch: 2, text: "A reply longer than the old sixty-second limit." });
    send({ type: "finish", epoch: 2 });
    await until(() => ended);
    assert.equal(seconds, 75);
    assert.equal(epochs.filter((epoch) => epoch === 0).length, 5);
    assert.equal(epochs.filter((epoch) => epoch === 1).length, 5);
    assert.deepEqual(errors, []);
  } finally {
    child.kill(); lines.close();
    await new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("close", () => resolve()); });
    await rm(directory, { recursive: true, force: true });
  }
});
