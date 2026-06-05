import AVFoundation
import Foundation
import WhisperKit

/// On-device speech-to-text via WhisperKit (Argmax, MIT) — Whisper running on
/// CoreML + the Apple Neural Engine with NATIVE real-time streaming. Replaces the
/// old whisper.cpp shell-out (temp WAV → afconvert → `whisper-cli` per chunk): no
/// external binary, no temp files, no re-transcribing the whole clip — WhisperKit
/// owns the mic and emits live partials as you speak. All local; audio never
/// leaves the Mac. The model (Korean-improved `large-v3-v20240930` turbo) is
/// downloaded once from HuggingFace, then cached.
final class WhisperCapture {
    enum CaptureError: Error, Equatable { case modelUnavailable }

    /// "ko" / "en" / "auto" (auto → WhisperKit detects).
    var languageCode = "auto"

    /// The September-2024 large-v3 checkpoint (notably better Korean) in its
    /// `turbo` variant — ~8× faster decoder so streaming stays real-time.
    private let modelName = "large-v3-v20240930_turbo"
    private static let placeholder = "Waiting for speech..."

    private var loadTask: Task<WhisperKit, Error>?
    private var whisperKit: WhisperKit?
    private var transcriber: AudioStreamTranscriber?
    private var streamTask: Task<Void, Never>?
    private var onPartial: ((String) -> Void)?
    private var onDone: ((String) -> Void)?
    private let textLock = NSLock()
    private var latestText = ""
    private(set) var running = false

    /// True once the CoreML model is loaded (so the first tap won't cold-start).
    var isReady: Bool { whisperKit != nil }

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

    /// Kick off the one-time model load in the background so the first voice tap
    /// is instant. Safe to call repeatedly (the load happens once).
    func preload() { _ = ensureModelTask() }

    private func ensureModelTask() -> Task<WhisperKit, Error> {
        if let loadTask { return loadTask }
        let name = modelName
        let task = Task<WhisperKit, Error> { [weak self] in
            let started = Date()
            let kit = try await WhisperKit(WhisperKitConfig(model: name, verbose: false, logLevel: .error, prewarm: true, download: true))
            await MainActor.run { self?.whisperKit = kit }
            WhisperCapture.log("model loaded: \(name) in \(String(format: "%.1f", Date().timeIntervalSince(started)))s")
            return kit
        }
        loadTask = task
        return task
    }

    func start(onPartial: @escaping (String) -> Void, onDone: @escaping (String) -> Void) async throws {
        guard !running else { return }
        let kit = try await ensureModelTask().value
        guard let tokenizer = kit.tokenizer else { throw CaptureError.modelUnavailable }
        self.onPartial = onPartial
        self.onDone = onDone
        setLatest("")
        running = true

        let lang = (languageCode == "auto") ? nil : languageCode
        let options = DecodingOptions(
            verbose: false, task: .transcribe, language: lang,
            detectLanguage: lang == nil, skipSpecialTokens: true, withoutTimestamps: true
        )
        let transcriber = AudioStreamTranscriber(
            audioEncoder: kit.audioEncoder,
            featureExtractor: kit.featureExtractor,
            segmentSeeker: kit.segmentSeeker,
            textDecoder: kit.textDecoder,
            tokenizer: tokenizer,
            audioProcessor: kit.audioProcessor,
            decodingOptions: options
        ) { [weak self] _, newState in
            guard let self else { return }
            let text = WhisperCapture.liveText(newState)
            guard !text.isEmpty else { return }
            self.setLatest(text)
            let cb = self.onPartial
            DispatchQueue.main.async { cb?(text) }
        }
        self.transcriber = transcriber
        streamTask = Task {
            do { try await transcriber.startStreamTranscription() }
            catch { WhisperCapture.log("stream error: \(error.localizedDescription)") }
        }
    }

    func cancel() { finish(deliver: false) }
    func stopAndTranscribe() { finish(deliver: true) }

    private func finish(deliver: Bool) {
        guard running else { return }
        running = false
        let transcriber = self.transcriber
        let final = getLatest()
        let cb = onDone
        onDone = nil; onPartial = nil
        self.transcriber = nil
        streamTask = nil
        Task {
            await transcriber?.stopStreamTranscription()
            if deliver { DispatchQueue.main.async { cb?(final) } }
        }
    }

    /// Confirmed segments + the live hypothesis, with WhisperKit's idle
    /// placeholder filtered out — the smooth, growing transcript.
    private static func liveText(_ state: AudioStreamTranscriber.State) -> String {
        let confirmed = state.confirmedSegments.map { $0.text }.joined(separator: " ")
        let current = state.currentText == placeholder ? "" : state.currentText
        return (confirmed + " " + current).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func setLatest(_ text: String) { textLock.lock(); latestText = text; textLock.unlock() }
    private func getLatest() -> String { textLock.lock(); defer { textLock.unlock() }; return latestText }
}
