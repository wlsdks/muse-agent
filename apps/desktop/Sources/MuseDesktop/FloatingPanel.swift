import AppKit
import MuseDesktopCore

/// The always-on-top, transparent, draggable companion window. Clicking the
/// Muse reveals a text field; submitting it runs the local Muse, shows the
/// cited answer in a speech bubble, and reads it aloud while she mouths along.
final class FloatingPanel: NSPanel, NSTextFieldDelegate {
    private let character = CharacterView(frame: NSRect(x: 0, y: 0, width: 132, height: 150))
    private let bubble = NSTextField(labelWithString: "")
    private let input = NSTextField()
    private let speaker: Speaker = SpeakerFactory.make()
    private var busy = false

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 300),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .floating
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isMovableByWindowBackground = true // drag anywhere to reposition

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 300))
        contentView = content

        // Speech bubble — a soft rounded card above the Muse.
        bubble.frame = NSRect(x: 16, y: 176, width: 328, height: 108)
        bubble.maximumNumberOfLines = 6
        bubble.lineBreakMode = .byWordWrapping
        bubble.font = NSFont.systemFont(ofSize: 13)
        bubble.textColor = NSColor(calibratedRed: 0.16, green: 0.16, blue: 0.2, alpha: 1)
        bubble.drawsBackground = true
        bubble.backgroundColor = NSColor(calibratedWhite: 1, alpha: 0.94)
        bubble.isBordered = false
        bubble.wantsLayer = true
        bubble.layer?.cornerRadius = 14
        bubble.layer?.borderWidth = 1
        bubble.layer?.borderColor = NSColor(calibratedRed: 0.90, green: 0.74, blue: 0.36, alpha: 0.6).cgColor
        bubble.stringValue = "Hi, I'm Muse. Click me and ask about your notes."
        content.addSubview(bubble)

        character.frame = NSRect(x: 18, y: 18, width: 132, height: 150)
        character.sprite = SpriteLibrary.named(ProcessInfo.processInfo.environment["MUSE_DESKTOP_CHARACTER"])
        character.onClick = { [weak self] in self?.revealInput() }
        content.addSubview(character)

        input.frame = NSRect(x: 168, y: 64, width: 176, height: 28)
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
        setFrameOrigin(NSPoint(x: visible.maxX - frame.width - margin, y: visible.minY + margin))
    }

    private func revealInput() {
        guard !busy else { return }
        input.isHidden = false
        character.state = .listening
        makeKey()
        makeFirstResponder(input)
    }

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
            let result: Result<String, MuseBridgeError>
            do {
                result = .success(try await MuseBridge.ask(query: trimmed))
            } catch let error as MuseBridgeError {
                result = .failure(error)
            } catch {
                result = .failure(.cliFailed(status: -1, stderr: "\(error)"))
            }
            let presentation = MusePresenter.present(result)
            await MainActor.run {
                guard let self else { return }
                self.bubble.stringValue = presentation.bubbleText
                self.busy = false
                if let speech = presentation.speechText {
                    self.character.state = .speaking
                    self.speaker.speak(speech) { [weak self] in self?.character.state = .idle }
                } else {
                    self.character.state = .idle
                }
            }
        }
    }
}
