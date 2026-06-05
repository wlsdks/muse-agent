import SwiftUI

/// Hosts the animated `CharacterView` (the orb / mascot / pixel sprite, Core
/// Graphics) inside SwiftUI, so the rest of the companion UI can be modern
/// SwiftUI while the avatar keeps its own animation.
struct OrbRepresentable: NSViewRepresentable {
    let lookName: String?
    var state: CharacterView.State
    let onClick: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var lastLook: String?? = .some(.some("__unset__")) }

    func makeNSView(context: Context) -> CharacterView {
        let view = CharacterView(frame: NSRect(x: 0, y: 0, width: 116, height: 116))
        view.onClick = onClick
        view.setCharacterNamed(lookName)
        context.coordinator.lastLook = .some(lookName)
        return view
    }

    func updateNSView(_ view: CharacterView, context: Context) {
        // Only re-apply the look when it actually changes (it resets the
        // animation), but update the state every time.
        if context.coordinator.lastLook != .some(lookName) {
            context.coordinator.lastLook = .some(lookName)
            view.setCharacterNamed(lookName)
        }
        view.state = state
    }
}
