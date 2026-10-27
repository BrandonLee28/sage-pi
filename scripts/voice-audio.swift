// One macOS audio engine gives voice processing the playback reference it needs for echo cancellation.
import AVFoundation
import Foundation

let wireLock = NSLock()
func send(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    wireLock.lock()
    FileHandle.standardOutput.write(data + Data([10]))
    wireLock.unlock()
}
func failure(_ message: String) -> NSError {
    NSError(domain: "SageVoice", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

@available(macOS 10.15, *)
final class VoiceAudio {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let commands = DispatchQueue(label: "sage.voice.audio")
    let speechFormat = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
    var epoch = 0
    var queuedFrames = 0
    var routeObserver: NSObjectProtocol?

    func start() throws {
        let input = engine.inputNode
        do { try input.setVoiceProcessingEnabled(true) }
        catch { throw failure("Enabling echo cancellation: \(error.localizedDescription)") }
        input.isVoiceProcessingAGCEnabled = false // Keep the calibrated noise floor stable.
        if #available(macOS 14.0, *) {
            input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
        }
        guard input.isVoiceProcessingEnabled else { throw failure("macOS voice processing could not be enabled.") }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: speechFormat)
        // VoiceProcessingIO requires matching input/output rates. Do not inherit the mixer's 44.1 kHz default.
        let hardwareRate = input.outputFormat(forBus: 0).sampleRate
        guard hardwareRate > 0 else { throw failure("No available microphone. Check macOS sound input and microphone permission.") }
        let ioFormat = AVAudioFormat(standardFormatWithSampleRate: hardwareRate, channels: 1)!
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: ioFormat)
        let source = ioFormat
        let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
        guard source.sampleRate > 0, source.channelCount > 0,
              let converter = AVAudioConverter(from: source, to: target) else {
            throw failure("No usable microphone. Check the Mac's sound input and microphone permission.")
        }
        // AVAudioNode taps run off the realtime render thread; conversion and stdio stay here.
        input.installTap(onBus: 0, bufferSize: 1024, format: source) { buffer, _ in
            let count = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / source.sampleRate)) + 32
            guard let pcm = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: count) else { return }
            var supplied = false
            var error: NSError?
            converter.convert(to: pcm, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true; status.pointee = .haveData; return buffer
            }
            if let error { send(["type": "error", "message": error.localizedDescription]); return }
            if pcm.frameLength > 0, let samples = pcm.int16ChannelData?[0] {
                send(["type": "mic", "pcm": Data(bytes: samples, count: Int(pcm.frameLength) * 2).base64EncodedString()])
            }
        }
        do { try engine.start() }
        catch { throw failure("Starting microphone/playback: \(error.localizedDescription)") }
        player.play()
        routeObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in
            send(["type": "error", "message": "Audio device changed. Restart /speak to recalibrate."])
            exit(1)
        }
        send(["type": "ready", "playbackCredits": true])
    }

    func handle(_ job: [String: Any]) throws {
        guard let type = job["type"] as? String, let requested = job["epoch"] as? Int else {
            throw failure("Invalid audio command.")
        }
        if type == "cancel" {
            epoch = requested
            player.stop(); queuedFrames = 0; player.play()
            return
        }
        guard requested == epoch else { return }
        if type == "audio" {
            guard let encoded = job["pcm"] as? String, let data = Data(base64Encoded: encoded),
                  data.count > 0, data.count % 4 == 0, job["sampleRate"] as? Int == 24000 else {
                throw failure("Invalid speech PCM format.")
            }
            let frames = data.count / 4
            guard queuedFrames + frames <= 24000 * 60 else { throw failure("Too much queued speech. Ask for a shorter reply.") }
            let buffer = AVAudioPCMBuffer(pcmFormat: speechFormat, frameCapacity: AVAudioFrameCount(frames))!
            buffer.frameLength = buffer.frameCapacity
            _ = data.withUnsafeBytes { bytes in memcpy(buffer.floatChannelData![0], bytes.baseAddress!, data.count) }
            queuedFrames += frames
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in
                self.commands.async {
                    if self.epoch == requested {
                        self.queuedFrames -= frames
                        send(["type": "audio_played", "epoch": requested, "frames": frames])
                    }
                }
            }
        } else if type == "audio_end" {
            // A marker scheduled after all speech reports actual playback completion, not synthesis completion.
            let marker = AVAudioPCMBuffer(pcmFormat: speechFormat, frameCapacity: 1)!
            marker.frameLength = 1; marker.floatChannelData![0][0] = 0
            player.scheduleBuffer(marker, completionCallbackType: .dataPlayedBack) { _ in
                self.commands.async {
                    if self.epoch == requested { send(["type": "audio_end", "epoch": requested]) }
                }
            }
        } else { throw failure("Unknown audio command.") }
    }

    func run() {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                while let line = readLine() {
                    guard let job = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
                        throw failure("Invalid audio command.")
                    }
                    try self.commands.sync { try self.handle(job) }
                }
                self.engine.stop(); exit(0)
            } catch { send(["type": "error", "message": error.localizedDescription]); self.engine.stop(); exit(1) }
        }
    }
}

signal(SIGPIPE, SIG_IGN)
if #available(macOS 10.15, *) {
    do {
        let audio = VoiceAudio()
        try audio.start()
        audio.run()
        RunLoop.main.run()
    } catch { send(["type": "error", "message": error.localizedDescription]); exit(1) }
} else { send(["type": "error", "message": "Voice processing requires macOS 10.15 or later."]); exit(1) }
