/**
 * Flat string dictionaries for the two shipped languages. Keys are
 * dot-namespaced; both maps MUST carry the same keys (enforced by the
 * `Strings` type below). `{name}`-style placeholders are filled by `t()`.
 */

export type Lang = "en" | "ko";

const en = {
  "brand.sub": "AI Conductor",

  "group.workspace": "Workspace",
  "group.knowledge": "Knowledge",
  "group.system": "System",

  "nav.today": "Today",
  "nav.chat": "Chat",
  "nav.tasks": "Tasks",
  "nav.calendar": "Calendar",
  "nav.reminders": "Reminders",
  "nav.notes": "Notes",
  "nav.activity": "Activity",
  "nav.tools": "Tools",
  "nav.settings": "Settings",

  "status.connected": "Connected",
  "status.connecting": "Connecting",
  "status.offline": "Offline",

  "common.add": "Add",
  "common.delete": "Delete",
  "common.close": "Close",
  "common.send": "Send",
  "common.save": "Save & reconnect",
  "common.snooze30": "Snooze 30m",
  "common.empty": "Nothing here yet.",
  "common.loadFailed": "Failed to load",
  "filter.open": "open",
  "filter.done": "done",
  "filter.all": "all",

  "today.greeting.lateNight": "Still up",
  "today.greeting.morning": "Good morning",
  "today.greeting.afternoon": "Good afternoon",
  "today.greeting.evening": "Good evening",
  "today.greetingLine": "{greeting}, Stark",
  "today.summary": "{tasks} open tasks · {events} events ahead · {reminders} reminders",
  "today.openTasks": "Open tasks",
  "today.upcomingEvents": "Upcoming events",
  "today.pendingReminders": "Pending reminders",
  "today.tasks": "Tasks",
  "today.calendar": "Calendar",
  "today.reminders": "Reminders",
  "today.proactive": "Proactive notices",

  "rel.now": "now",
  "rel.inMinutes": "in {n}m",
  "rel.inHours": "in {n}h",
  "rel.inDays": "in {n}d",

  "tasks.title": "Tasks",
  "tasks.placeholder": "Add a task and press Enter…",
  "tasks.yourTasks": "Your tasks",
  "tasks.complete": "Complete",

  "calendar.title": "Calendar",
  "calendar.today": "Today",
  "calendar.tomorrow": "Tomorrow",
  "calendar.allDay": "All day",

  "reminders.title": "Reminders",
  "reminders.new": "New reminder",
  "reminders.what": "What",
  "reminders.when": "When",
  "reminders.whatPlaceholder": "Call the dentist",
  "reminders.pending": "Pending",

  "notes.title": "Notes",
  "notes.searchPlaceholder": "Search across all notes…",
  "notes.files": "Files",
  "notes.results": "Search results",
  "notes.reader": "Reader",
  "notes.selectNote": "Select a note to read it.",

  "activity.title": "Activity",
  "activity.recentRuns": "Recent runs",
  "activity.proactive": "Proactive notices",

  "tools.title": "Tools",
  "tools.subtitle": "The capabilities Muse can call. {n} registered.",
  "tools.filterPlaceholder": "Filter tools…",

  "settings.title": "Settings",
  "settings.connection": "Connection",
  "settings.apiUrl": "API server URL",
  "settings.token": "Bearer token (optional)",
  "settings.tokenPlaceholder": "leave empty for local",
  "settings.activeModel": "Active model",
  "settings.modelsAvailable": "{n} models available",
  "settings.setupStatus": "Setup status",
  "settings.ready": "ready",
  "settings.notSet": "not set",
  "settings.language": "Language",
  "settings.credit": "Design system derived from Linear via VoltAgent/awesome-design-md (MIT). See apps/web/design/DESIGN.md.",

  "chat.askAnything": "Ask Muse anything",
  "chat.askSub": "It can check your tasks, calendar, notes, the web, and more.",
  "chat.placeholder": "Message Muse…  (Enter to send, Shift+Enter for newline)",
  "chat.calling": "calling {tool}…",
  "chat.clear": "Clear conversation"
} as const;

export type StringKey = keyof typeof en;
type Strings = Record<StringKey, string>;

const ko: Strings = {
  "brand.sub": "AI 지휘자",

  "group.workspace": "워크스페이스",
  "group.knowledge": "지식",
  "group.system": "시스템",

  "nav.today": "오늘",
  "nav.chat": "대화",
  "nav.tasks": "할 일",
  "nav.calendar": "캘린더",
  "nav.reminders": "리마인더",
  "nav.notes": "노트",
  "nav.activity": "활동",
  "nav.tools": "도구",
  "nav.settings": "설정",

  "status.connected": "연결됨",
  "status.connecting": "연결 중",
  "status.offline": "오프라인",

  "common.add": "추가",
  "common.delete": "삭제",
  "common.close": "닫기",
  "common.send": "보내기",
  "common.save": "저장 후 재연결",
  "common.snooze30": "30분 미루기",
  "common.empty": "아직 항목이 없습니다.",
  "common.loadFailed": "불러오기 실패",
  "filter.open": "진행",
  "filter.done": "완료",
  "filter.all": "전체",

  "today.greeting.lateNight": "아직 안 주무셨네요",
  "today.greeting.morning": "좋은 아침이에요",
  "today.greeting.afternoon": "좋은 오후예요",
  "today.greeting.evening": "좋은 저녁이에요",
  "today.greetingLine": "{greeting}, Stark 님",
  "today.summary": "진행 중인 할 일 {tasks}개 · 예정 일정 {events}개 · 리마인더 {reminders}개",
  "today.openTasks": "진행 중 할 일",
  "today.upcomingEvents": "예정된 일정",
  "today.pendingReminders": "대기 중 리마인더",
  "today.tasks": "할 일",
  "today.calendar": "캘린더",
  "today.reminders": "리마인더",
  "today.proactive": "선제 알림",

  "rel.now": "지금",
  "rel.inMinutes": "{n}분 후",
  "rel.inHours": "{n}시간 후",
  "rel.inDays": "{n}일 후",

  "tasks.title": "할 일",
  "tasks.placeholder": "할 일을 입력하고 Enter…",
  "tasks.yourTasks": "내 할 일",
  "tasks.complete": "완료",

  "calendar.title": "캘린더",
  "calendar.today": "오늘",
  "calendar.tomorrow": "내일",
  "calendar.allDay": "종일",

  "reminders.title": "리마인더",
  "reminders.new": "새 리마인더",
  "reminders.what": "내용",
  "reminders.when": "시각",
  "reminders.whatPlaceholder": "치과 예약 전화하기",
  "reminders.pending": "대기 중",

  "notes.title": "노트",
  "notes.searchPlaceholder": "모든 노트에서 검색…",
  "notes.files": "파일",
  "notes.results": "검색 결과",
  "notes.reader": "뷰어",
  "notes.selectNote": "읽을 노트를 선택하세요.",

  "activity.title": "활동",
  "activity.recentRuns": "최근 실행",
  "activity.proactive": "선제 알림",

  "tools.title": "도구",
  "tools.subtitle": "Muse가 호출할 수 있는 기능. {n}개 등록됨.",
  "tools.filterPlaceholder": "도구 검색…",

  "settings.title": "설정",
  "settings.connection": "연결",
  "settings.apiUrl": "API 서버 URL",
  "settings.token": "Bearer 토큰 (선택)",
  "settings.tokenPlaceholder": "로컬은 비워두세요",
  "settings.activeModel": "활성 모델",
  "settings.modelsAvailable": "사용 가능 모델 {n}개",
  "settings.setupStatus": "설정 상태",
  "settings.ready": "준비됨",
  "settings.notSet": "미설정",
  "settings.language": "언어",
  "settings.credit": "디자인 시스템은 VoltAgent/awesome-design-md(MIT)의 Linear에서 가져왔습니다. apps/web/design/DESIGN.md 참고.",

  "chat.askAnything": "무엇이든 Muse에게 물어보세요",
  "chat.askSub": "할 일, 캘린더, 노트, 웹 등을 확인할 수 있어요.",
  "chat.placeholder": "Muse에게 메시지…  (Enter 전송, Shift+Enter 줄바꿈)",
  "chat.calling": "{tool} 호출 중…",
  "chat.clear": "대화 지우기"
};

export const DICTIONARIES: Record<Lang, Strings> = { en, ko };

export const LOCALES: Record<Lang, string> = { en: "en-US", ko: "ko-KR" };
