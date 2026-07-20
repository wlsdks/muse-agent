import AppKit
import ApplicationServices
import Foundation

// muse-mac-helper — headless, READ-ONLY macOS state reader.
//
// Contract with the Node side:
//   • one subcommand per invocation, result on stdout as a single JSON object
//   • ALWAYS exits 0 with a JSON body, including for errors — a non-zero exit
//     with no JSON is reserved for a genuine crash, so the caller can tell
//     "the helper answered 'permission denied'" from "the helper is broken"
//   • every error carries a machine-readable `code`, never only prose
//
// There is deliberately no `click`, `type`, or `set` subcommand. Adding one
// would cross the AX-input line this design excludes.

// MARK: - Output

struct HelperError: Error {
    let code: String
    let message: String
}

func emit(_ value: [String: Any]) {
    // sortedKeys keeps output stable so tests can compare byte-for-byte.
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
        print(#"{"code":"serialize_failed","ok":false}"#)
        return
    }
    print(text)
}

func emitError(_ code: String, _ message: String) {
    emit(["code": code, "message": message, "ok": false])
}

// MARK: - Accessibility (READ ONLY)

/// Whether this process is a trusted accessibility client.
///
/// `AXIsProcessTrustedWithOptions` is Apple's documented check
/// (kAXTrustedCheckOptionPrompt controls whether the user is prompted). We pass
/// prompt=false: a background read must never throw a system dialog at the
/// user. Muse asks for the permission deliberately, from its own UI, with an
/// explanation — never as a side effect of answering a question.
func axTrusted() -> Bool {
    // Apple exposes kAXTrustedCheckOptionPrompt as a mutable C global, which
    // Swift 6 strict concurrency rejects. Its VALUE is a documented constant
    // string, so referencing it by name is equivalent and concurrency-clean.
    let options = ["AXTrustedCheckOptionPrompt": false] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value as? String
}

func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
          let raw = value else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(raw as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
          let raw = value else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(raw as! AXValue, .cgSize, &size) else { return nil }
    return size
}

/// Every on-screen window of every regular (Dock-visible) app.
///
/// Background-only agents are skipped: they have no windows a user would
/// recognise, and including them turns a readable answer into noise.
func readWindows() throws -> [String: Any] {
    guard axTrusted() else {
        throw HelperError(
            code: "ax_permission_denied",
            message: "Accessibility permission is required to read window state. Grant it in System Settings > Privacy & Security > Accessibility."
        )
    }

    var windows: [[String: Any]] = []
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &raw) == .success,
              let appWindows = raw as? [AXUIElement] else { continue }

        for window in appWindows {
            var entry: [String: Any] = [
                "app": app.localizedName ?? "unknown",
                "focused": app.isActive
            ]
            if let title = axString(window, kAXTitleAttribute as String), !title.isEmpty {
                entry["title"] = title
            }
            if let position = axPoint(window, kAXPositionAttribute as String) {
                entry["x"] = Int(position.x)
                entry["y"] = Int(position.y)
            }
            if let size = axSize(window, kAXSizeAttribute as String) {
                entry["width"] = Int(size.width)
                entry["height"] = Int(size.height)
            }
            windows.append(entry)
        }
    }
    return ["ok": true, "windows": windows]
}

/// The frontmost app and its focused window title — the cheapest possible
/// "where is the user right now" answer, for when a full window list is more
/// than the caller needs.
func readFocus() throws -> [String: Any] {
    guard let front = NSWorkspace.shared.frontmostApplication else {
        return ["app": NSNull(), "ok": true]
    }
    var result: [String: Any] = ["app": front.localizedName ?? "unknown", "ok": true]
    if let bundleId = front.bundleIdentifier { result["bundleId"] = bundleId }

    // The window title needs AX; the app name does not. Degrade to the app name
    // alone rather than failing the whole read — a partial answer beats none.
    if axTrusted() {
        let axApp = AXUIElementCreateApplication(front.processIdentifier)
        var raw: CFTypeRef?
        if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &raw) == .success,
           let window = raw {
            if let title = axString(window as! AXUIElement, kAXTitleAttribute as String), !title.isEmpty {
                result["windowTitle"] = title
            }
        }
    } else {
        result["axAvailable"] = false
    }
    return result
}

/// Running apps the user would recognise, without touching AX at all — so this
/// answers even when Accessibility has not been granted.
func readApps() -> [String: Any] {
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .map { app -> [String: Any] in
            var entry: [String: Any] = ["name": app.localizedName ?? "unknown", "active": app.isActive]
            if let bundleId = app.bundleIdentifier { entry["bundleId"] = bundleId }
            return entry
        }
    return ["apps": apps, "ok": true]
}

/// Permission posture, so the caller can explain what is missing instead of
/// silently returning less.
func readPermissions() -> [String: Any] {
    ["accessibility": axTrusted(), "ok": true]
}

// MARK: - Dispatch

let arguments = Array(CommandLine.arguments.dropFirst())
guard let subcommand = arguments.first else {
    emitError("missing_subcommand", "usage: muse-mac-helper <windows|focus|apps|permissions>")
    exit(0)
}

do {
    switch subcommand {
    case "windows": emit(try readWindows())
    case "focus": emit(try readFocus())
    case "apps": emit(readApps())
    case "permissions": emit(readPermissions())
    default:
        emitError("unknown_subcommand", "unknown subcommand '\(subcommand)' — expected windows, focus, apps, or permissions")
    }
} catch let error as HelperError {
    emitError(error.code, error.message)
} catch {
    emitError("unexpected", error.localizedDescription)
}
exit(0)
