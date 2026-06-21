import Foundation
import MuseDesktopCore

/// Localized strings for the NATIVE desktop UI (menu bar + Settings). The web app
/// localizes itself; this covers the AppKit/SwiftUI chrome so a Korean user sees
/// Korean everywhere. Resolved from the user's language preference.
struct UIStrings {
    let lang: ResolvedLanguage

    static func current() -> UIStrings {
        let pref = AppLanguage.fromPersisted(PrefsStore.load().language)
        let systemKorean = (Locale.preferredLanguages.first ?? "en").hasPrefix("ko")
        return UIStrings(lang: resolveLanguage(pref, systemIsKorean: systemKorean))
    }

    private func t(_ ko: String, _ en: String) -> String { lang == .korean ? ko : en }

    // Menu bar
    var menuOpenFull: String { t("Muse 열기 (전체 앱)", "Open Muse (full app)") }
    var menuShowHide: String { t("Muse 보이기 / 숨기기  (⌃⌥Space)", "Show / Hide Muse  (⌃⌥Space)") }
    var menuCharacter: String { t("캐릭터", "Character") }
    var menuLanguage: String { t("언어", "Language") }
    var menuMute: String { t("음성 끄기", "Mute voice") }
    var menuSettings: String { t("설정…", "Settings…") }
    var menuQuit: String { t("Muse 종료", "Quit Muse") }
    var characterGoddess: String { t("여신", "Goddess") }
    var characterOrb: String { t("오브", "Orb") }

    // Settings window
    var settingsTitle: String { t("Muse 설정", "Muse Settings") }
    var tagline: String { t("세상이 아니라, 너를 학습한다.", "Learns you, not the world.") }
    var openFull: String { t("Muse 열기 — 대화 & 모든 기능", "Open Muse — chat & all features") }
    var openFullSub: String { t("대화·오늘·할 일·캘린더·노트·메모리·도구 — 터미널 없이.",
                                "Chat, today, tasks, calendar, notes, memory & tools — no terminal needed.") }
    var sectionAppearance: String { t("외형", "Appearance") }
    var sectionVoice: String { t("음성", "Voice") }
    var sectionStartup: String { t("시작", "Startup") }
    var launchAtLogin: String { t("로그인 시 Muse 자동 실행", "Launch Muse at login") }
    var sectionPrivacy: String { t("프라이버시", "Privacy") }
    var sectionAdvanced: String { t("고급", "Advanced") }
    var rowCharacter: String { t("캐릭터", "Character") }
    var rowLanguage: String { t("언어", "Language") }
    var muteSpoken: String { t("음성 답변 끄기", "Mute spoken replies") }
    var privacyLocal: String { t("로컬 모델로 동작 — 데이터는 이 Mac을 벗어나지 않아요 (기본 로컬 전용).",
                                 "Runs on your local model — your data never leaves this Mac (local-only by default).") }
    var privacyHotkey: String { t("⌃⌥Space로 어디서나 Muse를 켜고 끌 수 있어요.",
                                  "Show / hide Muse anywhere with ⌃⌥Space.") }
    var customURL: String { t("사용자 지정 Muse 웹 URL", "Custom Muse web URL") }
    var customURLHint: String { t("비워 두면 내장 서버를 사용합니다.", "Leave empty to use the built-in server.") }
    var customURLPlaceholder: String { t("자동 (내장 서버)", "auto (bundled server)") }
    var quit: String { t("Muse 종료", "Quit Muse") }
    var openHint: String { t("플로팅 Muse를 더블클릭해도 전체 앱이 열려요.",
                             "Double-click the floating Muse to open the full app, too.") }
}
