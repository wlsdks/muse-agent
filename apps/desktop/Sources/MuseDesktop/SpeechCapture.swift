import AVFoundation
import Foundation
import MuseDesktopCore
import Speech

/// One-shot, on-device, push-to-talk speech capture for the companion. Captures
/// the mic via AVAudioEngine and transcribes with SFSpeechRecognizer pinned to
/// `requiresOnDeviceRecognition = true` — so your voice never leaves the Mac
/// (it refuses rather than fall back to the network). End-of-speech is detected
/// by a short silence; a hard cap bounds the session.
final class SpeechCapture {
    enum CaptureError: Error, Equatable {
        case unavailable          // no bundle usage strings / denied / recognizer down → caller types instead
        case offDeviceUnavailable // on-device model missing → refuse (no network)
        case alreadyRunning
    }

    /// Set from the language preference (ko-KR / en-US); the recognizer is built
    /// per-start so a language change takes effect.
    var localeIdentifier = "en-US"
    private let endSilence: TimeInterval = 1.2
    private let maxDuration: TimeInterval = 55

    private let engine = AVAudioEngine()
    // `request` is touched by the audio-thread tap AND the main thread (finish),
    // so every access is guarded by `lock` to avoid a data race / use-after-end.
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private var maxTimer: Timer?
    private var running = false
    private var lastText = ""
    private var onPartial: ((String) -> Void)?
    private var onFinal: ((String) -> Void)?

    /// True only inside a real .app bundle that declares both usage strings.
    /// Requesting mic/speech authorization without them HARD-CRASHES the process,
    /// so this gate is what keeps `swift run` from crashing on a click.
    private var usageStringsPresent: Bool {
        let info = Bundle.main.infoDictionary
        return info?["NSSpeechRecognitionUsageDescription"] != nil
            && info?["NSMicrophoneUsageDescription"] != nil
    }

    func start(onPartial: @escaping (String) -> Void, onFinal: @escaping (String) -> Void) async throws {
        guard !running else { throw CaptureError.alreadyRunning }
        guard usageStringsPresent else { throw CaptureError.unavailable }

        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier))
        let speechOK = await requestSpeechAuth()
        let micOK = await requestMicAuth()
        switch VoiceGate.decide(
            usageStringsPresent: true,
            speechAuthorized: speechOK,
            micAuthorized: micOK,
            recognizerAvailable: recognizer?.isAvailable ?? false,
            supportsOnDevice: recognizer?.supportsOnDeviceRecognition ?? false
        ) {
        case .fallbackToText: throw CaptureError.unavailable
        case .refuseOffDevice: throw CaptureError.offDeviceUnavailable
        case .listen: break
        }
        guard let recognizer else { throw CaptureError.unavailable }

        self.onPartial = onPartial
        self.onFinal = onFinal
        lastText = ""

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true
        req.shouldReportPartialResults = true
        lock.lock(); request = req; lock.unlock()

        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            guard let self else { return }
            self.lock.lock(); let r = self.request; self.lock.unlock()
            r?.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            // Partial-setup cleanup: remove the tap + drop the request so a retry is clean.
            input.removeTap(onBus: 0)
            lock.lock(); request = nil; lock.unlock()
            self.onPartial = nil; self.onFinal = nil
            throw error
        }
        running = true

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.running else { return }
                if let result {
                    self.lastText = result.bestTranscription.formattedString
                    self.onPartial?(self.lastText)
                    self.resetSilenceTimer()
                    if result.isFinal { self.finish() }
                }
                if error != nil { self.finish() }
            }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.running else { return }
            self.resetSilenceTimer()
            self.maxTimer = Timer.scheduledTimer(withTimeInterval: self.maxDuration, repeats: false) { [weak self] _ in
                DispatchQueue.main.async { self?.finish() }
            }
        }
    }

    func cancel() { finish(deliver: false) }

    private func resetSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: endSilence, repeats: false) { [weak self] _ in
            DispatchQueue.main.async { self?.finish() }
        }
    }

    private func finish(deliver: Bool = true) {
        guard running else { return }
        running = false
        silenceTimer?.invalidate(); silenceTimer = nil
        maxTimer?.invalidate(); maxTimer = nil
        // Drop the request FIRST (under lock) so a concurrent tap reads nil and
        // stops appending; only then stop the engine + remove the tap + endAudio.
        lock.lock(); let req = request; request = nil; lock.unlock()
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        req?.endAudio()
        task?.cancel()
        task = nil
        let text = lastText
        let callback = onFinal
        onFinal = nil
        onPartial = nil
        if deliver { callback?(text) }
    }

    deinit { if running { finish(deliver: false) } }

    private func requestSpeechAuth() async -> Bool {
        await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0 == .authorized) }
        }
    }

    private func requestMicAuth() async -> Bool {
        await withCheckedContinuation { cont in
            AVCaptureDevice.requestAccess(for: .audio) { cont.resume(returning: $0) }
        }
    }
}
