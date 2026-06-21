import SwiftUI

/// The modern, glassmorphic companion UI (SwiftUI). Idle = just the orb (gently
/// drifting); an answer card / input appear only when needed. While listening,
/// notes drift up; while thinking, an animated typing indicator. Frosted
/// "Liquid Glass" over the desktop with spring transitions.
struct CompanionView: View {
    @ObservedObject var model: CompanionModel
    @State private var drift = false

    private let accent = Color(red: 0.62, green: 0.91, blue: 1.0)
    private let violet = Color(red: 0.55, green: 0.45, blue: 0.95)

    var body: some View {
        VStack(spacing: 12) {
            answerCard
            Spacer(minLength: 0)
            orb
            if model.inputVisible { inputBar }
            Spacer(minLength: 0)
        }
        .padding(18)
        .frame(width: 360, height: 360)
        .background(WindowDragArea())
        .animation(.spring(response: 0.34, dampingFraction: 0.82), value: model.inputVisible)
        .animation(.easeInOut(duration: 0.22), value: model.bubble)
        .animation(.easeInOut(duration: 0.22), value: model.orbState)
        .onAppear { drift = true }
    }

    private var orb: some View {
        OrbRepresentable(lookName: model.lookName, state: model.orbState, onClick: { model.clickOrb() })
            .frame(width: 188, height: 224)
            .offset(y: drift ? -5 : 5)
            .animation(.easeInOut(duration: 3.2).repeatForever(autoreverses: true), value: drift)
    }

    @ViewBuilder private var answerCard: some View {
        if !model.bubble.isEmpty {
            card {
                ScrollView {
                    Text(model.bubble)
                        .font(.system(size: 13.5))
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .lineSpacing(2.5)
                }
                .frame(maxHeight: 150)
            }
        } else if model.orbState == .thinking {
            card { HStack { TypingIndicator(color: violet); Spacer() } }
        }
    }

    /// The shared frosted-glass card style.
    @ViewBuilder private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(16)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(
                        LinearGradient(colors: [violet.opacity(0.55), accent.opacity(0.45)], startPoint: .topLeading, endPoint: .bottomTrailing),
                        lineWidth: 1
                    )
            )
            .shadow(color: violet.opacity(0.22), radius: 18, x: 0, y: 8)
            .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var inputBar: some View {
        HStack(spacing: 12) {
            Button(action: { model.startVoice() }) {
                Image(systemName: model.orbState == .listening ? "stop.circle.fill" : "mic.fill")
                    .font(.system(size: model.orbState == .listening ? 17 : 14, weight: .medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(model.orbState == .listening ? Color(red: 0.95, green: 0.45, blue: 0.5) : Color.secondary)
            .help(model.orbState == .listening ? "Tap to finish" : "Talk to Muse by voice")

            TextField(model.language.askPlaceholder, text: $model.inputText)
                .textFieldStyle(.plain)
                .font(.system(size: 13.5))
                .onSubmit { model.submit() }

            Button(action: { model.submit() }) {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 20, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(LinearGradient(colors: [violet, Color(red: 0.40, green: 0.62, blue: 0.98)], startPoint: .top, endPoint: .bottom))
            .opacity(model.inputText.trimmingCharacters(in: .whitespaces).isEmpty ? 0.35 : 1)
        }
        .padding(.horizontal, 17)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(.white.opacity(0.22), lineWidth: 0.8))
        .shadow(color: .black.opacity(0.2), radius: 12, x: 0, y: 4)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// Three dots pulsing in a wave — Muse is thinking.
private struct TypingIndicator: View {
    let color: Color
    @State private var animating = false
    var body: some View {
        HStack(spacing: 7) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(color)
                    .frame(width: 8, height: 8)
                    .scaleEffect(animating ? 1 : 0.45)
                    .opacity(animating ? 1 : 0.4)
                    .animation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true).delay(Double(i) * 0.18), value: animating)
            }
        }
        .onAppear { animating = true }
    }
}

/// Musical notes drifting up around the orb — a clear "I'm listening" signal.
private struct ListeningNotes: View {
    let accent: Color
    @State private var animate = false
    var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { i in
                Image(systemName: "music.note")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(accent)
                    .offset(x: [-20, 4, 24][i], y: animate ? -52 : -6)
                    .opacity(animate ? 0 : 0.95)
                    .animation(.easeOut(duration: 1.7).repeatForever(autoreverses: false).delay(Double(i) * 0.55), value: animate)
            }
        }
        .onAppear { animate = true }
    }
}

/// Mini musical notes drifting freely around the avatar — always on, since Muse
/// is the goddess of music. Each note bobs along its own slow looping path.
private struct AmbientNotes: View {
    let tint: Color
    @State private var float = false

    private struct Note {
        let glyph: String, x: CGFloat, y: CGFloat, dx: CGFloat, dy: CGFloat
        let size: CGFloat, delay: Double, dur: Double, maxOpacity: Double
    }
    private let notes: [Note] = [
        .init(glyph: "\u{266A}", x: -88, y: -16, dx: -10, dy: -28, size: 15, delay: 0.0, dur: 4.4, maxOpacity: 0.55),
        .init(glyph: "\u{266B}", x: 82, y: -42, dx: 14, dy: -22, size: 18, delay: 0.8, dur: 5.2, maxOpacity: 0.60),
        .init(glyph: "\u{2669}", x: -66, y: 48, dx: -12, dy: 22, size: 13, delay: 1.7, dur: 4.8, maxOpacity: 0.45),
        .init(glyph: "\u{266C}", x: 94, y: 26, dx: 12, dy: 24, size: 16, delay: 0.4, dur: 5.6, maxOpacity: 0.50),
        .init(glyph: "\u{266A}", x: 22, y: -80, dx: 8, dy: -18, size: 14, delay: 2.3, dur: 4.2, maxOpacity: 0.50),
        .init(glyph: "\u{266B}", x: -28, y: 76, dx: -8, dy: 18, size: 15, delay: 1.2, dur: 5.0, maxOpacity: 0.45)
    ]

    var body: some View {
        ZStack {
            ForEach(0..<notes.count, id: \.self) { i in
                let n = notes[i]
                Text(n.glyph)
                    .font(.system(size: n.size, weight: .semibold))
                    .foregroundStyle(tint)
                    .shadow(color: tint.opacity(0.5), radius: 4)
                    .offset(x: float ? n.x + n.dx : n.x, y: float ? n.y + n.dy : n.y)
                    .rotationEffect(.degrees(float ? 10 : -10))
                    .opacity(float ? n.maxOpacity : n.maxOpacity * 0.25)
                    .animation(.easeInOut(duration: n.dur).repeatForever(autoreverses: true).delay(n.delay), value: float)
            }
        }
        .onAppear { float = true }
    }
}
