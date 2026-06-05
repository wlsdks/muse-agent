import SwiftUI

/// The modern, glassmorphic companion UI (SwiftUI). A frosted answer card, the
/// glowing orb, and a frosted capsule input — translucent "Liquid Glass" over
/// the desktop, with smooth spring transitions. Researched from Apple's macOS
/// Tahoe / Liquid-Glass material direction.
struct CompanionView: View {
    @ObservedObject var model: CompanionModel

    var body: some View {
        VStack(spacing: 12) {
            answerCard
            Spacer(minLength: 0)
            OrbRepresentable(lookName: model.lookName, state: model.orbState, onClick: { model.clickOrb() })
                .frame(width: 116, height: 116)
            Spacer(minLength: 0)
            if model.inputVisible { inputBar }
        }
        .padding(18)
        .frame(width: 360, height: 360)
        .animation(.spring(response: 0.34, dampingFraction: 0.82), value: model.inputVisible)
        .animation(.easeInOut(duration: 0.22), value: model.bubble)
    }

    @ViewBuilder private var answerCard: some View {
        if !model.bubble.isEmpty {
            ScrollView {
                Text(model.bubble)
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 150)
            .padding(15)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(.white.opacity(0.18), lineWidth: 0.8)
            )
            .shadow(color: .black.opacity(0.24), radius: 18, x: 0, y: 8)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private var inputBar: some View {
        HStack(spacing: 12) {
            Button(action: { model.startVoice() }) {
                Image(systemName: "mic.fill").font(.system(size: 14, weight: .medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)

            TextField(model.language.askPlaceholder, text: $model.inputText)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .onSubmit { model.submit() }

            Button(action: { model.submit() }) {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 19, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(
                LinearGradient(colors: [Color(red: 0.55, green: 0.45, blue: 0.95), Color(red: 0.40, green: 0.62, blue: 0.98)],
                               startPoint: .top, endPoint: .bottom)
            )
            .opacity(model.inputText.trimmingCharacters(in: .whitespaces).isEmpty ? 0.35 : 1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(.white.opacity(0.22), lineWidth: 0.8))
        .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 4)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
