"""Optional native speech bindings over stdio. Pi owns all agent behavior in TypeScript."""
import argparse
import base64
import collections
import json
import math
import os
from pathlib import Path
import queue
import struct
import sys
import threading
import time


class SpeechDetector:
    """Calibrate room noise, then require sustained VAD + energy above that floor."""
    def __init__(self, vad, emit, silence_ms=400):
        self.vad, self.emit = vad, emit
        self.silence_frames = silence_ms // 20
        self.pending = b""
        self.history = collections.deque(maxlen=10)
        self.frames = []
        self.positive = self.silent = self.id = 0
        self.voiced = self.tick = 0
        self.calibration = []
        self.threshold_db = None

    def feed(self, pcm):
        self.pending += pcm
        while len(self.pending) >= 640:
            frame, self.pending = self.pending[:640], self.pending[640:]
            samples = struct.unpack("<320h", frame)
            rms = math.sqrt(sum(value * value for value in samples) / 320) / 32768
            db = 20 * math.log10(max(rms, 1e-6))
            self.tick += 1
            if self.threshold_db is None:
                self.calibration.append(db)
                if self.tick % 5 == 0:
                    self.emit("calibrating", 0, len(self.calibration) / 100)
                if len(self.calibration) == 100:
                    self.noise_db = sorted(self.calibration)[79]
                    self.threshold_db = max(-48, self.noise_db + 10)
                    self.emit("calibrated", 0, self.threshold_db)
                continue
            if self.tick % 5 == 0:
                level = max(0, min(1, (db - self.threshold_db + 12) / 30))
                self.emit("level", 0, level)
            voiced = db >= self.threshold_db and self.vad.is_speech(frame, 16000)
            if not self.frames:
                self.history.append(frame)
                self.positive = self.positive + 1 if voiced else 0
                if self.positive < 8:
                    continue
                self.id += 1
                self.frames = list(self.history)
                self.voiced = self.positive
                self.history.clear()
                self.emit("speech_start", self.id, None)
            else:
                self.frames.append(frame)
                self.voiced += int(voiced)
            self.silent = 0 if voiced else self.silent + 1
            if self.silent >= self.silence_frames or len(self.frames) >= 1500:
                if self.voiced >= 12:
                    self.emit("speech_end", self.id, (b"".join(self.frames), time.time() * 1000 - self.silent * 20))
                else:
                    self.emit("speech_discarded", self.id, None)
                self.frames = []
                self.positive = self.silent = self.voiced = 0


def transcribe(asr, samples):
    # A fresh stream prevents one utterance's decoder state leaking into the next.
    stream = asr.create_stream()
    stream.accept_waveform(16000, samples)
    asr.decode_stream(stream)
    return stream.result.text.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tts-model", required=True)
    parser.add_argument("--asr-model", default="")
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--voice", default="")
    parser.add_argument("--silence-ms", type=int, default=400)
    args = parser.parse_args()
    # Native libraries can log to fd 1. Reserve a separate fd for the JSON protocol.
    wire = os.fdopen(os.dup(1), "w", buffering=1)
    os.dup2(2, 1)
    output_lock = threading.Lock()

    def send(kind, **data):
        with output_lock:
            wire.write(json.dumps({"type": kind, **data}) + "\n")

    import numpy as np
    import ptts
    import webrtcvad
    import sherpa_onnx
    model = Path(args.asr_model or Path(args.cache_dir) / "parakeet-unified-en-0.6b")
    required = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]
    if not all((model / name).is_file() for name in required):
        raise FileNotFoundError(f"Parakeet model files are missing from {model}. Run npm run voice:setup; VOICE_ASR_MODEL must name a Parakeet ONNX folder.")
    tts = ptts.TTS(args.tts_model, lang="en", quant="q8")
    asr = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(model / required[0]), decoder=str(model / required[1]),
        joiner=str(model / required[2]), tokens=str(model / required[3]),
        num_threads=4, sample_rate=16000, feature_dim=128,
        model_type="nemo_transducer", decoding_method="greedy_search", provider="cpu")
    speech_jobs, recognition_jobs = queue.Queue(maxsize=32), queue.Queue(maxsize=1)
    epoch = 0

    def synthesize():
        while True:
            job = speech_jobs.get()
            if job["epoch"] != epoch:
                continue
            try:
                if job["type"] == "finish":
                    send("audio_end", epoch=job["epoch"])
                    continue
                if not job["text"].strip():
                    continue
                options = {"voice": args.voice} if args.voice else {}
                with tts.stream(job["text"], **options) as audio:
                    for pcm in audio:
                        if job["epoch"] != epoch:
                            break
                        send("audio", epoch=job["epoch"], sampleRate=audio.sample_rate,
                             pcm=base64.b64encode(pcm.astype("<f4").tobytes()).decode())
            except Exception as error:
                # ptts 0.4.0 normalizes emoji-only chunks to empty text (plan.rs).
                # This is a silent phrase, not a failed voice session.
                if isinstance(error, ValueError) and str(error) == "nothing to synthesize: the text is empty":
                    continue
                send("error", message=f"Speech generation failed: {error}")

    def recognize():
        while True:
            identifier, pcm, ended_at = recognition_jobs.get()
            try:
                samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
                text = transcribe(asr, samples)
                send("transcript", id=identifier, text=text,
                     endedAt=ended_at, asrDoneAt=time.time() * 1000)
            except Exception as error:
                send("error", message=f"Transcription failed: {error}")

    def detected(kind, identifier, data):
        if kind in ("speech_start", "speech_discarded"):
            send(kind, id=identifier)
        elif kind in ("calibrating", "calibrated", "level"):
            send(kind, value=data)
        elif kind == "speech_end":
            pcm, ended_at = data
            send(kind, id=identifier)
            if recognition_jobs.full():
                try:
                    recognition_jobs.get_nowait()
                except queue.Empty:
                    pass
            recognition_jobs.put_nowait((identifier, pcm, ended_at))

    detector = SpeechDetector(webrtcvad.Vad(2), detected, args.silence_ms)
    threading.Thread(target=synthesize, daemon=True).start()
    threading.Thread(target=recognize, daemon=True).start()
    send("ready")
    for line in sys.stdin:
        job = json.loads(line)
        if job["type"] == "mic":
            detector.feed(base64.b64decode(job["pcm"], validate=True))
        elif job["type"] == "cancel":
            epoch = job["epoch"]
            try:
                while True:
                    speech_jobs.get_nowait()
            except queue.Empty:
                pass
        elif job["type"] in ("speak", "finish"):
            try:
                speech_jobs.put_nowait(job)
            except queue.Full:
                send("error", message="Voice speech queue is full. Ask for a shorter spoken reply.")


if __name__ == "__main__":
    main()
