"""Optional native speech bindings over stdio. Pi owns all agent behavior in TypeScript."""
import argparse
import base64
import collections
import json
import os
import queue
import sys
import threading
import time


class SpeechDetector:
    """20 ms WebRTC frames, 200 ms pre-roll, bounded utterances, and a configurable pause."""
    def __init__(self, vad, emit, silence_ms=400):
        self.vad, self.emit = vad, emit
        self.silence_frames = silence_ms // 20
        self.pending = b""
        self.history = collections.deque(maxlen=10)
        self.frames = []
        self.positive = self.silent = self.id = 0

    def feed(self, pcm):
        self.pending += pcm
        while len(self.pending) >= 640:
            frame, self.pending = self.pending[:640], self.pending[640:]
            voiced = self.vad.is_speech(frame, 16000)
            if not self.frames:
                self.history.append(frame)
                self.positive = self.positive + 1 if voiced else 0
                if self.positive < 3:
                    continue
                self.id += 1
                self.frames = list(self.history)
                self.history.clear()
                self.emit("speech_start", self.id, None)
            else:
                self.frames.append(frame)
            self.silent = 0 if voiced else self.silent + 1
            if self.silent >= self.silence_frames or len(self.frames) >= 1500:
                self.emit("speech_end", self.id, (b"".join(self.frames), time.time() * 1000 - self.silent * 20))
                self.frames = []
                self.positive = self.silent = 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tts-model", required=True)
    parser.add_argument("--asr-model", default="base.en")
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
    from pywhispercpp.model import Model
    tts = ptts.TTS(args.tts_model, lang="en", quant="q8")
    asr = Model(args.asr_model, models_dir=args.cache_dir, n_threads=4,
                print_progress=False, print_realtime=False, print_timestamps=False,
                language="en", no_context=True, no_timestamps=True)
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
                options = {"voice": args.voice} if args.voice else {}
                with tts.stream(job["text"], **options) as audio:
                    for pcm in audio:
                        if job["epoch"] != epoch:
                            break
                        send("audio", epoch=job["epoch"], sampleRate=audio.sample_rate,
                             pcm=base64.b64encode(pcm.astype("<f4").tobytes()).decode())
            except Exception as error:
                send("error", message=f"Speech generation failed: {error}")

    def recognize():
        while True:
            identifier, pcm, ended_at = recognition_jobs.get()
            try:
                samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
                segments = asr.transcribe(samples)
                send("transcript", id=identifier, text=" ".join(s.text.strip() for s in segments).strip(),
                     endedAt=ended_at, asrDoneAt=time.time() * 1000)
            except Exception as error:
                send("error", message=f"Transcription failed: {error}")

    def detected(kind, identifier, data):
        if kind == "speech_start":
            send(kind, id=identifier)
        else:
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
