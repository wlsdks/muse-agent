import AVFoundation
import Foundation

/// Push-to-talk speech capture using the OPEN-SOURCE whisper.cpp. Records the mic
/// (AVAudioEngine), and — because whisper.cpp isn't streaming — transcribes the
/// audio-so-far every ~1.5s to give NEAR-REAL-TIME partial text in the input
/// field, plus a final pass on stop. All local; your voice never leaves the Mac.
///
/// Setup (one-time): `brew install whisper-cpp` + a GGML model at
/// `~/.muse/whisper-models/ggml-base.bin` (multilingual, handles Korean).
final class WhisperCapture {
    enum CaptureError: Error, Equatable { case unavailable, alreadyRunning }

    var languageCode = "auto" // "ko" / "en" / "auto"

    private let endSilence: TimeInterval = 1.6
    private let noSpeechGrace: TimeInterval = 7
    private let maxDuration: TimeInterval = 30
    private let interimEvery: TimeInterval = 1.5
    private let rmsThreshold: Float = 0.02

    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var samples: [Float] = []
    private var sampleRate: Double = 48000
    private var running = false
    private var spoke = false
    private var maxRMS: Float = 0
    private var startedAt = Date()
    private var interimBusy = false
    private var silenceTimer: Timer?
    private var maxTimer: Timer?
    private var noSpeechTimer: Timer?
    private var interimTimer: Timer?
    private var onPartial: ((String) -> Void)?
    private var onDone: ((String) -> Void)?

    static func binaryPath() -> String? {
        for path in ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]
        where FileManager.default.isExecutableFile(atPath: path) { return path }
        return nil
    }
    static func modelPath() -> String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".muse/whisper-models/ggml-base.bin")
    }
    static var isAvailable: Bool { binaryPath() != nil && FileManager.default.fileExists(atPath: modelPath()) }

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

    static func log(_ message: String) {
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
        let url = URL(fileURLWithPath: (NSHomeDirectory() as NSString).appendingPathComponent(".muse/voice-debug.log"))
        if let data = line.data(using: .utf8) {
            if let handle = try? FileHandle(forWritingTo: url) { handle.seekToEndOfFile(); handle.write(data); try? handle.close() }
            else { try? data.write(to: url) }
        }
    }

    var isRunning: Bool { running }

    func start(onPartial: @escaping (String) -> Void, onDone: @escaping (String) -> Void) throws {
        guard !running else { throw CaptureError.alreadyRunning }
        guard Self.isAvailable else { throw CaptureError.unavailable }
        self.onPartial = onPartial
        self.onDone = onDone
        spoke = false; maxRMS = 0; startedAt = Date(); interimBusy = false
        lock.lock(); samples.removeAll(keepingCapacity: true); samples.reserveCapacity(48000 * 30); lock.unlock()

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        sampleRate = format.sampleRate
        Self.log("start: sr=\(format.sampleRate) ch=\(format.channelCount) lang=\(languageCode) micAuth=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)")

        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self, let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
            let n = Int(buffer.frameLength)
            var sum: Float = 0
            self.lock.lock()
            for i in 0..<n { let s = data[i]; self.samples.append(s); sum += s * s }
            self.lock.unlock()
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
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0); onDone(""); throw error
        }
        running = true

        DispatchQueue.main.async { [weak self] in
            guard let self, self.running else { return }
            self.noSpeechTimer = Timer.scheduledTimer(withTimeInterval: self.noSpeechGrace, repeats: false) { [weak self] _ in self?.stop(transcribe: true) }
            self.maxTimer = Timer.scheduledTimer(withTimeInterval: self.maxDuration, repeats: false) { [weak self] _ in self?.stop(transcribe: true) }
            self.interimTimer = Timer.scheduledTimer(withTimeInterval: self.interimEvery, repeats: true) { [weak self] _ in self?.runInterim() }
        }
    }

    func cancel() { stop(transcribe: false) }
    func stopAndTranscribe() { stop(transcribe: true) }

    private func resetSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: endSilence, repeats: false) { [weak self] _ in self?.stop(transcribe: true) }
    }

    /// Transcribe the audio captured so far (off the main thread) → onPartial.
    private func runInterim() {
        guard running, spoke, !interimBusy else { return }
        interimBusy = true
        lock.lock(); let snapshot = samples; let rate = sampleRate; lock.unlock()
        guard snapshot.count > Int(rate / 2) else { interimBusy = false; return } // need ≥0.5s
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let text = WhisperCapture.transcribe(snapshot, rate: rate, lang: self?.languageCode ?? "auto")
            DispatchQueue.main.async {
                guard let self, self.running else { return }
                self.interimBusy = false
                if !text.isEmpty { self.onPartial?(text) }
            }
        }
    }

    private func stop(transcribe: Bool) {
        guard running else { return }
        running = false
        silenceTimer?.invalidate(); maxTimer?.invalidate(); noSpeechTimer?.invalidate(); interimTimer?.invalidate()
        silenceTimer = nil; maxTimer = nil; noSpeechTimer = nil; interimTimer = nil
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        lock.lock(); let snapshot = samples; let rate = sampleRate; lock.unlock()
        let callback = onDone
        onDone = nil; onPartial = nil
        let lang = languageCode
        Self.log("stop: transcribe=\(transcribe) spoke=\(spoke) maxRMS=\(maxRMS) dur=\(String(format: "%.1f", Date().timeIntervalSince(startedAt)))s samples=\(snapshot.count)")

        guard transcribe, snapshot.count > Int(rate / 4) else {
            DispatchQueue.main.async { callback?("") }
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let text = WhisperCapture.transcribe(snapshot, rate: rate, lang: lang)
            DispatchQueue.main.async { callback?(text) }
        }
    }

    // MARK: - transcription

    private static func transcribe(_ samples: [Float], rate: Double, lang: String) -> String {
        guard let binary = binaryPath() else { return "" }
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("muse-voice-\(UUID().uuidString)")
        let raw = base.appendingPathExtension("wav")
        let wav16 = base.appendingPathExtension("16k.wav")
        let outBase = base.path + ".out"
        defer {
            for p in [raw.path, wav16.path, outBase + ".txt"] { try? FileManager.default.removeItem(atPath: p) }
        }
        guard writeWAV(samples, sampleRate: Int(rate), to: raw) else { return "" }
        runProcess("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", raw.path, wav16.path])
        let wStatus = runProcess(binary, ["-m", modelPath(), "-f", wav16.path, "-nt", "-l", lang, "-otxt", "-of", outBase])
        let text = ((try? String(contentsOfFile: outBase + ".txt", encoding: .utf8)) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if wStatus != 0 { log("transcribe: whisper exit \(wStatus)") }
        return text
    }

    /// Write float samples to a mono 16-bit PCM WAV at `sampleRate`.
    private static func writeWAV(_ samples: [Float], sampleRate: Int, to url: URL) -> Bool {
        let pcm: [Int16] = samples.map { Int16(max(-1, min(1, $0)) * 32767) }
        let dataSize = pcm.count * 2
        var data = Data()
        func ascii(_ s: String) { data.append(s.data(using: .ascii)!) }
        func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
        ascii("RIFF"); u32(UInt32(36 + dataSize)); ascii("WAVE")
        ascii("fmt "); u32(16); u16(1); u16(1); u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        ascii("data"); u32(UInt32(dataSize))
        pcm.withUnsafeBytes { data.append(contentsOf: $0) }
        return (try? data.write(to: url)) != nil
    }

    @discardableResult
    private static func runProcess(_ launchPath: String, _ args: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = args
        process.standardOutput = Pipe(); process.standardError = Pipe()
        do { try process.run(); process.waitUntilExit(); return process.terminationStatus }
        catch { return -1 }
    }
}
