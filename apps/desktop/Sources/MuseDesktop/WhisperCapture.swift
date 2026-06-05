import AVFoundation
import Foundation

/// Push-to-talk speech capture using the OPEN-SOURCE whisper.cpp (Jinan's call —
/// Apple's on-device recogniser isn't available on this Mac). It records the
/// mic to a WAV (AVAudioEngine), detects end-of-speech by audio level, then runs
/// `whisper-cli` locally — your voice never leaves the machine. whisper.cpp is
/// NOT streaming, so the transcript arrives after you stop (a couple of seconds).
///
/// Setup (one-time): `brew install whisper-cpp` + a GGML model at
/// `~/.muse/whisper-models/ggml-base.bin` (multilingual, handles Korean).
final class WhisperCapture {
    enum CaptureError: Error, Equatable { case unavailable, alreadyRunning }

    /// "ko" / "en" / "auto".
    var languageCode = "auto"

    private let endSilence: TimeInterval = 1.4   // stop this long after speech stops
    private let noSpeechGrace: TimeInterval = 7   // wait this long for speech to start
    private let maxDuration: TimeInterval = 45
    private let rmsThreshold: Float = 0.005 // lower = more sensitive (quiet mics)
    private var maxRMS: Float = 0
    private var startedAt = Date()

    /// Appends a line to ~/.muse/voice-debug.log so a real mic→whisper run can be
    /// diagnosed (did the mic capture audio? did whisper run? what came back?).
    static func log(_ message: String) {
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
        let url = URL(fileURLWithPath: (NSHomeDirectory() as NSString).appendingPathComponent(".muse/voice-debug.log"))
        if let data = line.data(using: .utf8) {
            if let handle = try? FileHandle(forWritingTo: url) { handle.seekToEndOfFile(); handle.write(data); try? handle.close() }
            else { try? data.write(to: url) }
        }
    }

    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var rawURL: URL?
    private var running = false
    private var spoke = false
    private var silenceTimer: Timer?
    private var maxTimer: Timer?
    private var noSpeechTimer: Timer?
    private var onDone: ((String) -> Void)?

    static func binaryPath() -> String? {
        for path in ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]
        where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        return nil
    }

    static func modelPath() -> String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".muse/whisper-models/ggml-base.bin")
    }

    static var isAvailable: Bool {
        binaryPath() != nil && FileManager.default.fileExists(atPath: modelPath())
    }

    /// Ensure microphone access (shows the TCC prompt on first use). Returns
    /// false if denied — caller falls back to typing.
    static func requestMic() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { cont in
                AVCaptureDevice.requestAccess(for: .audio) { cont.resume(returning: $0) }
            }
        default: return false
        }
    }

    /// Begin recording. `onDone(text)` is called on the main thread with the
    /// transcript ("" if nothing was heard). Throws `.unavailable` if whisper.cpp
    /// isn't installed (caller falls back to typing).
    func start(onDone: @escaping (String) -> Void) throws {
        guard !running else { throw CaptureError.alreadyRunning }
        guard Self.isAvailable else { throw CaptureError.unavailable }
        self.onDone = onDone
        spoke = false
        maxRMS = 0
        startedAt = Date()

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        Self.log("start: inputFormat sampleRate=\(format.sampleRate) ch=\(format.channelCount) lang=\(languageCode) micAuth=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("muse-voice-\(UUID().uuidString).wav")
        rawURL = url
        file = try AVAudioFile(forWriting: url, settings: format.settings)

        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.lock.lock(); try? self.file?.write(from: buffer); self.lock.unlock()
            self.handleLevel(buffer)
        }
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0); lock.lock(); file = nil; lock.unlock(); onDone("")
            throw error
        }
        running = true

        DispatchQueue.main.async { [weak self] in
            guard let self, self.running else { return }
            self.noSpeechTimer = Timer.scheduledTimer(withTimeInterval: self.noSpeechGrace, repeats: false) { [weak self] _ in
                self?.stop(transcribe: true) // transcribe anyway — let whisper decide, don't drop on a missed RMS
            }
            self.maxTimer = Timer.scheduledTimer(withTimeInterval: self.maxDuration, repeats: false) { [weak self] _ in
                self?.stop(transcribe: true)
            }
        }
    }

    func cancel() { stop(transcribe: false) }

    private func handleLevel(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        let n = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<n { sum += data[i] * data[i] }
        let rms = (sum / Float(n)).squareRoot()
        DispatchQueue.main.async { [weak self] in
            guard let self, self.running else { return }
            if rms > self.maxRMS { self.maxRMS = rms }
            if rms > self.rmsThreshold {
                self.spoke = true
                self.noSpeechTimer?.invalidate(); self.noSpeechTimer = nil
                self.resetSilenceTimer()
            }
        }
    }

    private func resetSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: endSilence, repeats: false) { [weak self] _ in
            self?.stop(transcribe: true)
        }
    }

    private func stop(transcribe: Bool) {
        guard running else { return }
        running = false
        silenceTimer?.invalidate(); silenceTimer = nil
        maxTimer?.invalidate(); maxTimer = nil
        noSpeechTimer?.invalidate(); noSpeechTimer = nil
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        lock.lock(); file = nil; let url = rawURL; rawURL = nil; lock.unlock() // closing the file flushes the WAV
        let callback = onDone
        onDone = nil
        let lang = languageCode
        let wavSize = (url.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? Int }) ?? 0
        Self.log("stop: transcribe=\(transcribe) spoke=\(spoke) maxRMS=\(maxRMS) dur=\(String(format: "%.1f", Date().timeIntervalSince(startedAt)))s wavBytes=\(wavSize)")

        // Transcribe whatever was recorded (whisper handles silence by returning
        // empty) — don't drop it just because the RMS gate didn't trip.
        guard transcribe, let url else {
            if let url { try? FileManager.default.removeItem(at: url) }
            DispatchQueue.main.async { callback?("") }
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let text = WhisperCapture.transcribe(url, lang: lang)
            try? FileManager.default.removeItem(at: url)
            DispatchQueue.main.async { callback?(text) }
        }
    }

    /// Resample the WAV to 16 kHz mono (whisper's expected input) then run
    /// `whisper-cli`, returning the transcript text.
    private static func transcribe(_ rawWav: URL, lang: String) -> String {
        guard let binary = binaryPath() else { return "" }
        let wav16 = rawWav.deletingPathExtension().appendingPathExtension("16k.wav")
        let outBase = rawWav.deletingPathExtension().path + ".out"
        defer {
            try? FileManager.default.removeItem(at: wav16)
            try? FileManager.default.removeItem(atPath: outBase + ".txt")
        }
        let afStatus = runProcess("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", rawWav.path, wav16.path])
        let wav16Size = (try? FileManager.default.attributesOfItem(atPath: wav16.path)[.size] as? Int) ?? 0
        let wStatus = runProcess(binary, ["-m", modelPath(), "-f", wav16.path, "-nt", "-l", lang, "-otxt", "-of", outBase])
        let text = (try? String(contentsOfFile: outBase + ".txt", encoding: .utf8)) ?? ""
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        log("transcribe: afconvert=\(afStatus) wav16Bytes=\(wav16Size) whisper=\(wStatus) text='\(trimmed.prefix(80))'")
        return trimmed
    }

    @discardableResult
    private static func runProcess(_ launchPath: String, _ args: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = args
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do { try process.run(); process.waitUntilExit(); return process.terminationStatus }
        catch { return -1 }
    }
}
