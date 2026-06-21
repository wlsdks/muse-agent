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
    var menuOpenFull: String { t("Muse 앱 열기", "Open Muse app") }
    var menuShowHide: String { t("Muse 보이기 / 숨기기  (⌃⌥Space)", "Show / Hide Muse  (⌃⌥Space)") }
    var menuCharacter: String { t("캐릭터", "Character") }
    var menuLanguage: String { t("언어", "Language") }
    var menuMute: String { t("음성 끄기", "Mute voice") }
    var menuSettings: String { t("설정…", "Settings…") }
    var menuGuide: String { t("시작 가이드", "Getting started") }
    var menuQuit: String { t("Muse 종료", "Quit Muse") }

    // Onboarding
    var onboardWelcome: String { t("Muse에 오신 걸 환영해요", "Welcome to Muse") }
    var onboardSubtitle: String { t("세상이 아니라 너를 학습하는 개인 AI.\n모두 네 Mac에서, 로컬로 동작해요.",
                                    "The personal AI that learns you, not the world.\nIt all runs locally, on your Mac.") }
    var onboardChecking: String { t("로컬 AI 준비 상태 확인 중…", "Checking your local AI…") }
    var onboardReady: String { t("로컬 AI 준비 완료 — 시작해요!", "Your local AI is ready — let's go!") }
    var onboardOpenFull: String { t("Muse 시작하기", "Start using Muse") }
    var onboardStart: String { t("나중에", "Later") }
    var characterGoddess: String { t("여신", "Goddess") }
    var characterOrb: String { t("오브", "Orb") }

    // Menu-bar status line
    var statusLocalOn: String { t("🔒 로컬 전용", "🔒 Local-only") }
    var statusLocalOff: String { t("⚠️ 클라우드 허용", "⚠️ Cloud allowed") }
    var statusServerOn: String { t("서버 켜짐", "server running") }
    var statusServerOff: String { t("서버 꺼짐", "server stopped") }

    // Settings window
    var settingsTitle: String { t("Muse 설정", "Muse Settings") }
    var tagline: String { t("세상이 아니라, 너를 학습한다.", "Learns you, not the world.") }
    var openFull: String { t("Muse 열기 — 대화 & 모든 기능", "Open Muse — chat & all features") }
    var openFullSub: String { t("대화·오늘·할 일·캘린더·노트·메모리·도구 — 터미널 없이.",
                                "Chat, today, tasks, calendar, notes, memory & tools — no terminal needed.") }
    var sectionAppearance: String { t("외형", "Appearance") }
    var sectionVoice: String { t("음성", "Voice") }
    var sectionModels: String { t("모델", "Models") }
    var modelsHint: String { t("터미널 없이 로컬 모델을 설치/삭제하세요.", "Install or remove local models — no terminal.") }
    var modelsEmpty: String { t("설치된 모델이 없어요", "No models installed") }
    var modelDefault: String { t("기본", "default") }
    var modelPullPlaceholder: String { t("모델 이름 (예: gemma4:12b)", "model name (e.g. gemma4:12b)") }
    var modelPull: String { t("받기", "Pull") }
    var modelPulling: String { t("받는 중…", "Pulling…") }
    var sectionStartup: String { t("시작", "Startup") }
    var launchAtLogin: String { t("로그인 시 Muse 자동 실행", "Launch Muse at login") }
    var sectionMessengers: String { t("메신저 연결", "Messengers") }
    var msgHint: String { t("토큰을 넣으면 Muse가 그 메신저에서 대화에 답해요. Keychain에 안전하게 저장됩니다.",
                            "Add a bot token and Muse replies in that messenger. Stored securely in the Keychain.") }
    var msgTelegram: String { t("Telegram 봇 토큰", "Telegram bot token") }
    var msgDiscord: String { t("Discord 봇 토큰", "Discord bot token") }
    var msgDiscordChannels: String { t("Discord 채널 ID (쉼표로 구분)", "Discord channel IDs (comma-separated)") }
    var msgSlack: String { t("Slack 봇 토큰", "Slack bot token") }
    var msgSlackChannels: String { t("Slack 채널 ID (쉼표로 구분)", "Slack channel IDs (comma-separated)") }
    var msgLineToken: String { t("LINE 채널 액세스 토큰", "LINE channel access token") }
    var msgLineSecret: String { t("LINE 채널 시크릿", "LINE channel secret") }
    var msgSave: String { t("저장 & 연결", "Save & connect") }
    var msgSaved: String { t("저장됨 — 서버 재시작 중…", "Saved — restarting the server…") }
    var sectionCalendars: String { t("캘린더 연결", "Calendars") }
    var calHint: String { t("캘린더를 연결하면 Muse가 일정을 읽고 관리해요.",
                            "Connect a calendar so Muse can read and manage your events.") }
    var calMacOS: String { t("macOS 캘린더 사용 (이 Mac)", "Use macOS Calendar (this Mac)") }
    var calCaldavURL: String { t("CalDAV URL", "CalDAV URL") }
    var calCaldavUser: String { t("CalDAV 사용자명", "CalDAV username") }
    var calCaldavPass: String { t("CalDAV 앱 비밀번호", "CalDAV app password") }
    var calGoogleHint: String { t("Google: client id / secret / refresh token (OAuth로 발급).",
                                  "Google: client id / secret / refresh token (obtained via OAuth).") }
    var calGClientId: String { t("Google client ID", "Google client ID") }
    var calGClientSecret: String { t("Google client secret", "Google client secret") }
    var calGRefresh: String { t("Google refresh token", "Google refresh token") }
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
