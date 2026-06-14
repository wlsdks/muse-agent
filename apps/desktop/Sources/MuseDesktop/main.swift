import AppKit
import Foundation
import MuseDesktopCore
import TTSKit
import WhisperKit

let arguments = CommandLine.arguments

// Print which Muse CLI the bridge resolves from THIS bundle context, then exit —
// used to confirm a built .app uses its bundled self-contained binary.
if arguments.contains("--print-bin") {
    print(MuseBridge.defaultBin())
    exit(0)
}

// Print the live Ollama health status: `MuseDesktop --check-ollama [baseURL]`.
if let f = arguments.firstIndex(of: "--check-ollama") {
    let url = f + 1 < arguments.count ? arguments[f + 1] : OllamaHealth.baseURL
    let done = DispatchSemaphore(value: 0)
    Task { print("ollama(\(url)): \(await OllamaHealth.check(baseURL: url))"); done.signal() }
    done.wait()
    exit(0)
}

// Headless chat self-test: `MuseDesktop --selftest-chat "<query>"`. Runs the
// EXACT path a typed companion turn uses — MuseBridge spawns the bundled CLI,
// MusePresenter shapes the bubble + spoken text — so the FULL desktop answer
// path is verifiable end-to-end without the GUI (synthetic clicks can't drive
// the non-activating panel). Prints BUBBLE (on-screen) and SPEECH (TTS) lines.
if let flag = arguments.firstIndex(of: "--selftest-chat"), flag + 1 < arguments.count {
    let query = arguments[flag + 1]
    let lang: ResolvedLanguage = query.range(of: "\\p{Hangul}", options: .regularExpression) != nil ? .korean : .english
    let done = DispatchSemaphore(value: 0)
    var code: Int32 = 1
    Task {
        let result: Result<String, MuseBridgeError>
        do { result = .success(try await MuseBridge.ask(query: query)) }
        catch let error as MuseBridgeError { result = .failure(error) }
        catch { result = .failure(.cliFailed(status: -1, stderr: "\(error)")) }
        let presentation = MusePresenter.present(result, language: lang)
        print("BUBBLE: \(presentation.bubbleText)")
        print("SPEECH: \(presentation.speechText ?? "(silent)")")
        if case .success = result { code = 0 }
        done.signal()
    }
    done.wait()
    exit(code)
}

/// Keep a user-supplied pixel scale in a sane range so a typo can't request a
/// multi-gigabyte bitmap (or a zero/negative one).
func clampScale(_ value: Int) -> Int { min(max(value, 1), 256) }

/// Write mono float samples to a 16-bit PCM WAV (used by the headless self-tests).
func writePCMWAV(_ samples: [Float], sampleRate: Int, to url: URL) {
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
    try? data.write(to: url)
}

// Headless TTS self-test: `MuseDesktop --selftest-tts <text> <out.wav> [ko|en]`.
// Loads TTSKit (Qwen3-TTS) and synthesizes text to a WAV — proves the on-device
// voice works (and lets you LISTEN with `afplay`) without the GUI.
if let flag = arguments.firstIndex(of: "--selftest-tts"), flag + 2 < arguments.count {
    let text = arguments[flag + 1]
    let outPath = arguments[flag + 2]
    let lang = flag + 3 < arguments.count ? arguments[flag + 3] : "en"
    let done = DispatchSemaphore(value: 0)
    var code: Int32 = 1
    Task {
        do {
            let started = Date()
            let tts = try await TTSKit(model: .qwen3TTS_0_6b)
            let loaded = Date().timeIntervalSince(started)
            let result = try await tts.generate(text: text, voice: nil, language: lang == "ko" ? "korean" : "english")
            writePCMWAV(result.audio, sampleRate: result.sampleRate, to: URL(fileURLWithPath: outPath))
            print("model-load=\(String(format: "%.1f", loaded))s  TTS[\(lang)]: \(String(format: "%.1f", result.audioDuration))s audio, \(result.audio.count) samples @\(result.sampleRate)Hz -> \(outPath)")
            code = result.audio.isEmpty ? 1 : 0
        } catch {
            FileHandle.standardError.write(Data("selftest-tts failed: \(error)\n".utf8))
        }
        done.signal()
    }
    done.wait()
    exit(code)
}

// Headless model-load self-test: `MuseDesktop --selftest-load`. Runs the EXACT
// WhisperKit.download(progress)+load path the live mic uses, printing download %
// to stderr — so the load path (and its progress) is verifiable without the GUI.
if let loadFlag = arguments.firstIndex(of: "--selftest-load") {
    let variant = loadFlag + 1 < arguments.count && !arguments[loadFlag + 1].hasPrefix("-")
        ? arguments[loadFlag + 1] : "small"
    let done = DispatchSemaphore(value: 0)
    var code: Int32 = 1
    Task {
        do {
            let started = Date()
            let folder = try await WhisperKit.download(variant: variant, progressCallback: { progress in
                FileHandle.standardError.write(Data("download \(Int(progress.fractionCompleted * 100))%\n".utf8))
            })
            let dl = Date()
            print("downloaded -> \(folder.lastPathComponent) (\(String(format: "%.1f", dl.timeIntervalSince(started)))s)")
            let kit = try await WhisperKit(WhisperKitConfig(modelFolder: folder.path, verbose: false, logLevel: .error))
            print("LOAD \(variant): \(String(format: "%.1f", Date().timeIntervalSince(dl)))s, tokenizer=\(kit.tokenizer != nil)")
            code = kit.tokenizer != nil ? 0 : 1
        } catch {
            FileHandle.standardError.write(Data("selftest-load failed: \(error)\n".utf8))
        }
        done.signal()
    }
    done.wait()
    exit(code)
}

// Headless STT self-test: `MuseDesktop --selftest-stt <wav> [ko|en]`. Loads the
// SAME WhisperKit model the live mic uses and transcribes a file, proving the
// on-device pipeline (download → CoreML load → transcribe) works at the layer
// that can be verified without a microphone.
if let flag = arguments.firstIndex(of: "--selftest-stt"), flag + 1 < arguments.count {
    let wav = arguments[flag + 1]
    let lang = flag + 2 < arguments.count ? arguments[flag + 2] : "en"
    let model = flag + 3 < arguments.count ? arguments[flag + 3] : "small"
    let done = DispatchSemaphore(value: 0)
    var code: Int32 = 1
    Task {
        do {
            let started = Date()
            let kit = try await WhisperKit(WhisperKitConfig(model: model, verbose: false, logLevel: .error, download: true))
            let loaded = Date().timeIntervalSince(started)
            let options = DecodingOptions(task: .transcribe, language: lang, skipSpecialTokens: true, withoutTimestamps: true)
            let results: [TranscriptionResult] = try await kit.transcribe(audioPath: wav, decodeOptions: options)
            let text = results.map { $0.text }.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            print("[\(model)] load=\(String(format: "%.1f", loaded))s  STT[\(lang)]: \(text)")
            code = 0
        } catch {
            FileHandle.standardError.write(Data("selftest-stt failed: \(error)\n".utf8))
        }
        done.signal()
    }
    done.wait()
    exit(code)
}

// Headless preview of the ACTIVE Muse: `MuseDesktop --render <png> [scale]`.
if let flag = arguments.firstIndex(of: "--render"), flag + 1 < arguments.count {
    let path = arguments[flag + 1]
    let scale = clampScale((flag + 2 < arguments.count ? Int(arguments[flag + 2]) : nil) ?? 18)
    do {
        let sprite = SpriteLibrary.named(ProcessInfo.processInfo.environment["MUSE_DESKTOP_CHARACTER"])
        try SpriteRenderer.renderPNG(sprite, to: URL(fileURLWithPath: path), scale: scale)
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("render failed: \(error)\n".utf8))
        exit(1)
    }
}

// Headless preview of the ORB: `MuseDesktop --render-orb <png> [size] [state] [phase]`.
if let flag = arguments.firstIndex(of: "--render-orb"), flag + 1 < arguments.count {
    let path = arguments[flag + 1]
    let size = min(max((flag + 2 < arguments.count ? Int(arguments[flag + 2]) : nil) ?? 320, 64), 2048)
    let stateName = flag + 3 < arguments.count ? arguments[flag + 3] : "idle"
    let phase = CGFloat((flag + 4 < arguments.count ? Double(arguments[flag + 4]) : nil) ?? 0)
    let state: CharacterView.State = stateName == "listening" ? .listening : stateName == "speaking" ? .speaking : stateName == "thinking" ? .thinking : .idle
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let gctx = NSGraphicsContext(bitmapImageRep: rep) else { exit(1) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = gctx
    NSColor(calibratedRed: 0.10, green: 0.09, blue: 0.16, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size)).fill()
    VoiceOrb.draw(in: NSRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size)), state: state, phase: phase)
    NSGraphicsContext.restoreGraphicsState()
    if let data = rep.representation(using: .png, properties: [:]) {
        try? data.write(to: URL(fileURLWithPath: path)); exit(0)
    }
    exit(1)
}

// Headless preview of the LYRE/HARP: `MuseDesktop --render-harp <png> [size] [state] [phase]`.
if let flag = arguments.firstIndex(of: "--render-harp"), flag + 1 < arguments.count {
    let path = arguments[flag + 1]
    let size = min(max((flag + 2 < arguments.count ? Int(arguments[flag + 2]) : nil) ?? 320, 64), 2048)
    let stateName = flag + 3 < arguments.count ? arguments[flag + 3] : "idle"
    let phase = CGFloat((flag + 4 < arguments.count ? Double(arguments[flag + 4]) : nil) ?? 0)
    let state: CharacterView.State = stateName == "listening" ? .listening : stateName == "speaking" ? .speaking : stateName == "thinking" ? .thinking : .idle
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let gctx = NSGraphicsContext(bitmapImageRep: rep) else { exit(1) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = gctx
    // dark backdrop so the glow reads, matching the companion's frosted panel
    NSColor(calibratedRed: 0.10, green: 0.09, blue: 0.16, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size)).fill()
    HarpMuse.draw(in: NSRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size)), state: state, phase: phase)
    NSGraphicsContext.restoreGraphicsState()
    if let data = rep.representation(using: .png, properties: [:]) {
        try? data.write(to: URL(fileURLWithPath: path)); exit(0)
    }
    exit(1)
}

// Headless preview of the VECTOR mascot: `MuseDesktop --render-vector <png> [size]`.
if let flag = arguments.firstIndex(of: "--render-vector"), flag + 1 < arguments.count {
    let path = arguments[flag + 1]
    let size = min(max((flag + 2 < arguments.count ? Int(arguments[flag + 2]) : nil) ?? 320, 64), 2048)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: Int(Double(size) * 1.2),
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let gctx = NSGraphicsContext(bitmapImageRep: rep) else { exit(1) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = gctx
    VectorMuse.draw(in: NSRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size) * 1.2), state: .idle, blink: false, mouthOpen: false, breathe: 0)
    NSGraphicsContext.restoreGraphicsState()
    if let data = rep.representation(using: .png, properties: [:]) {
        try? data.write(to: URL(fileURLWithPath: path)); exit(0)
    }
    exit(1)
}

// Headless preview of ANY candidate design: `MuseDesktop --render-json <sprite.json> <png> [scale]`.
if let flag = arguments.firstIndex(of: "--render-json"), flag + 2 < arguments.count {
    let jsonPath = arguments[flag + 1]
    let pngPath = arguments[flag + 2]
    let scale = clampScale((flag + 3 < arguments.count ? Int(arguments[flag + 3]) : nil) ?? 18)
    do {
        let sprite = try Sprite.decode(Data(contentsOf: URL(fileURLWithPath: jsonPath)))
        guard sprite.isRectangular() else {
            FileHandle.standardError.write(Data("sprite is not rectangular (\(sprite.width)x\(sprite.height), \(sprite.rows.count) rows)\n".utf8))
            exit(2)
        }
        guard sprite.paletteCoversGrid() else {
            FileHandle.standardError.write(Data("sprite references a glyph with no palette entry (would render a transparent hole)\n".utf8))
            exit(2)
        }
        guard sprite.paletteHexesValid() else {
            FileHandle.standardError.write(Data("sprite has a palette entry with an unparseable hex colour (would render a transparent hole)\n".utf8))
            exit(2)
        }
        try SpriteRenderer.renderPNG(sprite, to: URL(fileURLWithPath: pngPath), scale: scale)
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("render-json failed: \(error)\n".utf8))
        exit(1)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let controller = MuseController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller.start()
    }
}

let app = NSApplication.shared
// `.accessory` → no Dock icon and no menu bar; it lives as a floating companion.
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
