import AppKit
import MuseDesktopCore

/// The always-on-top, transparent, draggable companion window. Clicking the
/// character reveals a text field; submitting it runs the local Muse and shows
/// the cited answer in a speech bubble.
final class FloatingPanel: NSPanel, NSTextFieldDelegate {
    private let character = CharacterView(frame: NSRect(x: 0, y: 0, width: 88, height: 88))
    private let bubble = NSTextField(labelWithString: "")
    private let input = NSTextField()
    private var busy = false

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 220),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        // Float above normal windows, on every Space, no Dock/Mission-Control
        // chrome — a companion, not an app window.
        isFloatingPanel = true
        level = .floating
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // Drag anywhere on the (transparent) background to reposition.
        isMovableByWindowBackground = true

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 220))
        contentView = content

        bubble.frame = NSRect(x: 12, y: 120, width: 276, height: 92)
        bubble.maximumNumberOfLines = 5
        bubble.lineBreakMode = .byWordWrapping
        bubble.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.92)
        bubble.drawsBackground = true
        bubble.isBordered = false
        bubble.wantsLayer = true
        bubble.layer?.cornerRadius = 10
        bubble.stringValue = "Hi — I'm Muse. Click me and ask about your notes."
        content.addSubview(bubble)

        character.frame = NSRect(x: 12, y: 18, width: 88, height: 88)
        character.onClick = { [weak self] in self?.revealInput() }
        content.addSubview(character)

        input.frame = NSRect(x: 110, y: 40, width: 178, height: 28)
        input.placeholderString = "Ask Muse…"
        input.delegate = self
        input.isHidden = true
        input.bezelStyle = .roundedBezel
        content.addSubview(input)

        positionAtScreenBottomRight()
    }

    private func positionAtScreenBottomRight() {
        guard let screen = NSScreen.main else { return }
        let margin: CGFloat = 24
        let visible = screen.visibleFrame
        setFrameOrigin(NSPoint(
            x: visible.maxX - frame.width - margin,
            y: visible.minY + margin
        ))
    }

    private func revealInput() {
        guard !busy else { return }
        input.isHidden = false
        character.state = .listening
        makeKey()
        makeFirstResponder(input)
    }

    // Enter in the text field submits the question.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) {
            submit(input.stringValue)
            return true
        }
        return false
    }

    private func submit(_ query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !busy else { return }
        busy = true
        input.isHidden = true
        input.stringValue = ""
        character.state = .thinking
        bubble.stringValue = "…"

        Task { [weak self] in
            let result: String
            do {
                result = try await MuseBridge.ask(query: trimmed)
            } catch MuseBridgeError.cliFailed {
                result = "I couldn't reach the Muse CLI. Is `muse` on your PATH (or set MUSE_BIN)?"
            } catch {
                result = "Something went wrong asking Muse."
            }
            await MainActor.run {
                guard let self else { return }
                self.bubble.stringValue = result
                self.character.state = .speaking
                self.busy = false
            }
        }
    }
}
