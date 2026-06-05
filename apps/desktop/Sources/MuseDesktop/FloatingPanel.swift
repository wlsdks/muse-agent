import AppKit
import MuseDesktopCore

/// The always-on-top, transparent, draggable companion window. Clicking the
/// Muse lets you speak (or type) a question; she runs the local Muse, shows the
/// cited answer in a scrollable speech bubble, and reads it aloud while she
/// mouths along.
final class FloatingPanel: NSPanel, NSTextFieldDelegate {
    private let character = CharacterView(frame: NSRect(x: 0, y: 0, width: 132, height: 150))
    private let bubbleScroll = NSScrollView()
    private let bubbleText = NSTextView()
    private let input = NSTextField()
    private let speaker: Speaker = SpeakerFactory.make()
    private let speech = SpeechCapture()
    private var busy = false
    private var listening = false
    /// Toggled from the menu bar; when true the answer still shows but isn't spoken.
    var voiceMuted = false

    /// Switch the on-screen character live (menu bar → Character submenu).
    func setCharacter(_ name: String) { character.sprite = SpriteLibrary.named(name) }

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 300),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        // Always on top of normal app windows, on EVERY Space, and over a
        // full-screen app — a companion that's always there (Jinan: "항상 떠있게").
        level = .statusBar
        hidesOnDeactivate = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isMovableByWindowBackground = true // drag anywhere to reposition

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 300))
        contentView = content

        // Speech bubble — a scrollable rounded card so a long cited answer isn't
        // silently truncated (it scrolls instead).
        bubbleScroll.frame = NSRect(x: 16, y: 176, width: 328, height: 108)
        bubbleScroll.hasVerticalScroller = true
        bubbleScroll.drawsBackground = true
        bubbleScroll.backgroundColor = NSColor(calibratedWhite: 1, alpha: 0.94)
        bubbleScroll.wantsLayer = true
        bubbleScroll.layer?.cornerRadius = 14
        bubbleScroll.layer?.borderWidth = 1
        bubbleScroll.layer?.borderColor = NSColor(calibratedRed: 0.90, green: 0.74, blue: 0.36, alpha: 0.6).cgColor

        bubbleText.isEditable = false
        bubbleText.isSelectable = true
        bubbleText.drawsBackground = false
        bubbleText.font = NSFont.systemFont(ofSize: 13)
        bubbleText.textColor = NSColor(calibratedRed: 0.16, green: 0.16, blue: 0.2, alpha: 1)
        bubbleText.textContainerInset = NSSize(width: 6, height: 6)
        bubbleText.minSize = NSSize(width: 0, height: 0)
        bubbleText.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        bubbleText.isVerticallyResizable = true
        bubbleText.isHorizontallyResizable = false
        bubbleText.autoresizingMask = [.width]
        bubbleText.textContainer?.widthTracksTextView = true
        bubbleScroll.documentView = bubbleText
        content.addSubview(bubbleScroll)
        setBubble("Hi, I'm Muse. Click me and ask about your notes.")

        character.frame = NSRect(x: 18, y: 18, width: 132, height: 150)
        character.sprite = SpriteLibrary.named(ProcessInfo.processInfo.environment["MUSE_DESKTOP_CHARACTER"])
        character.onClick = { [weak self] in self?.handleClick() }
        content.addSubview(character)

        input.frame = NSRect(x: 168, y: 64, width: 176, height: 28)
        input.placeholderString = "Ask Muse…"
        input.delegate = self
        input.isHidden = true
        input.bezelStyle = .roundedBezel
        content.addSubview(input)

        positionAtBottomRight()
    }

    private func setBubble(_ text: String) {
        bubbleText.string = text
        bubbleText.scrollToBeginningOfDocument(nil)
    }

    /// Position at the bottom-right of the screen the CURSOR is on (not always
    /// the main display) so she lands on the user's active monitor.
    private func positionAtBottomRight() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        let margin: CGFloat = 24
        setFrameOrigin(NSPoint(x: visible.maxX - frame.width - margin, y: visible.minY + margin))
    }

    /// Click → talk: try on-device voice; if it's unavailable (e.g. `swift run`
    /// with no .app bundle, or permission denied) fall back to typing. A second
    /// click while listening cancels. Ignored while busy or while she's speaking.
    private func handleClick() {
        guard !busy, character.state != .speaking else { return }
        if listening { speech.cancel(); listening = false; character.state = .idle; return }
        // Set listening synchronously (before the async Task) so a rapid second
        // click reliably hits the cancel branch instead of starting twice.
        listening = true
        character.state = .listening
        setBubble("Listening… speak your question.")
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.speech.start(
                    onPartial: { [weak self] text in self?.setBubble(text.isEmpty ? "Listening…" : text) },
                    onFinal: { [weak self] text in self?.onHeard(text) }
                )
            } catch SpeechCapture.CaptureError.offDeviceUnavailable {
                self.listening = false
                self.setBubble("On-device speech isn't available for your language — type instead.")
                self.revealInput()
            } catch {
                self.listening = false
                self.revealInput() // no bundle / denied / busy → typing
            }
        }
    }

    private func onHeard(_ text: String) {
        listening = false
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty {
            character.state = .idle
            setBubble("I didn't catch that — click me to try again.")
            return
        }
        submit(q)
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
        setBubble("…")

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
                self.setBubble(presentation.bubbleText)
                self.busy = false
                if let speech = presentation.speechText, !self.voiceMuted {
                    self.character.state = .speaking
                    self.speaker.speak(speech) { [weak self] in self?.character.state = .idle }
                } else {
                    self.character.state = .idle
                }
            }
        }
    }
}
