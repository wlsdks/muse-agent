import AppKit
import Foundation
import MuseDesktopCore
import WhisperKit

let arguments = CommandLine.arguments

/// Keep a user-supplied pixel scale in a sane range so a typo can't request a
/// multi-gigabyte bitmap (or a zero/negative one).
func clampScale(_ value: Int) -> Int { min(max(value, 1), 256) }

// Headless STT self-test: `MuseDesktop --selftest-stt <wav> [ko|en]`. Loads the
// SAME WhisperKit model the live mic uses and transcribes a file, proving the
// on-device pipeline (download → CoreML load → transcribe) works at the layer
// that can be verified without a microphone.
if let flag = arguments.firstIndex(of: "--selftest-stt"), flag + 1 < arguments.count {
    let wav = arguments[flag + 1]
    let lang = flag + 2 < arguments.count ? arguments[flag + 2] : "en"
    let done = DispatchSemaphore(value: 0)
    var code: Int32 = 1
    Task {
        do {
            let started = Date()
            let kit = try await WhisperKit(WhisperKitConfig(model: "large-v3-v20240930_turbo", verbose: false, logLevel: .error, download: true))
            let loaded = Date().timeIntervalSince(started)
            let options = DecodingOptions(task: .transcribe, language: lang, skipSpecialTokens: true, withoutTimestamps: true)
            let results: [TranscriptionResult] = try await kit.transcribe(audioPath: wav, decodeOptions: options)
            let text = results.map { $0.text }.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            print("model-load=\(String(format: "%.1f", loaded))s  STT[\(lang)]: \(text)")
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
    VoiceOrb.draw(in: NSRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size)), state: state, phase: phase)
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
