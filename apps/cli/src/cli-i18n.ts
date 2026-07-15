/**
 * CLI i18n foundation (E4a): a flat EN/KO string catalog + a sync `t()`
 * lookup, mirroring `apps/web/src/i18n/strings.ts`'s pattern for the
 * terminal surface. Unlike the web (React state, per-render), the CLI
 * resolves its language ONCE per process (env > config > OS locale) via
 * `resolveCliLanguage`, caches it in a module-level variable, and every
 * subsequent `t()` call reads that cache synchronously — a prompt or
 * error-formatter never needs to be async just to translate a string.
 */

export type Lang = "en" | "ko";

const en = {
  "email.method.prompt": "How do you want to connect email?",
  "email.method.appPassword.label": "App Password (recommended)",
  "email.method.appPassword.hint": "2 minutes, Gmail or any other IMAP provider — no Google Cloud project",
  "email.method.oauth.label": "Google OAuth",
  "email.method.oauth.hint": "existing flow — needs a Google Cloud project + OAuth client",
  "email.setupCancelled": "Setup cancelled.",

  "email.gmail.appPasswordStep": "Opening the app-password page pinned to {email} (paste the 16 characters at the next step).\n  {appPasswordUrl}\nIf 2-Step Verification isn't on yet, enable it first:\n  {twoStepUrl}\n",
  "email.gmail.openBrowserConfirm": "Open the app-password page in your browser now?",
  "email.koWebmail.note": "{label}: in that provider's mail security settings, turn on IMAP access, enable 2-step verification, then generate an app password.",

  "email.prompt.email": "Email address:",
  "email.prompt.email.required": "Email is required",
  "email.prompt.email.invalidFormat": "That doesn't look like a valid email address",
  "email.prompt.appPassword": "App password (spaces are fine — they're stripped):",
  "email.prompt.appPassword.required": "App password is required",
  "email.prompt.host": "{label} host (leave blank to use the provider default):",

  "email.appPassword.connected": "✓ connected — inbox has {count} message(s)",
  "email.appPassword.verifyFailed": "muse setup email: could not connect — {detail}",

  "email.oauth.walkthrough": "Gmail setup — one-time browser consent, then it refreshes itself forever.\n\n  1. Open https://console.cloud.google.com/apis/library/gmail.googleapis.com\n     (create a project first if you don't have one) and click \"Enable\".\n  2. Open the Google Auth Platform: https://console.cloud.google.com/auth/overview\n     First time: click \"Get started\" and fill in the app name + your email\n     (this is the consent-screen \"Branding\" step). Choose \"External\".\n  3. Add yourself as a test user:\n     https://console.cloud.google.com/auth/audience → \"Test users\" → + Add users.\n  4. Create the client: https://console.cloud.google.com/auth/clients\n     \"+ Create client\" → Application type \"Desktop app\".\n  5. EASIEST: click ⬇ in the creation dialog to download the\n     client_secret_*.json and paste that file's PATH below — Muse reads the\n     ID + secret from it, so nothing can be mis-pasted or mismatched.\n     (Or copy the Client ID and Client Secret by hand as before.)\n\n  ⚠️  Google shows the Client Secret ONLY ONCE, in that creation dialog.\n      If you closed it, create a new client — the secret is not viewable later.\n  ⚠️  While the app's publishing status is \"Testing\", Google expires your\n      refresh token every 7 days (you'll re-run this wizard weekly). Publish\n      to \"Production\" on https://console.cloud.google.com/auth/audience to\n      avoid that — for personal use no verification review is needed.\n",
  "email.oauth.prompt.clientId": "Google OAuth Client ID (or path to the downloaded client_secret_*.json):",
  "email.oauth.prompt.clientSecret": "Google OAuth Client Secret:",
  "email.oauth.jsonRead.ok": "✓ Desktop-app client credentials read from the JSON",
  "email.oauth.jsonRead.fail": "muse setup email: could not read {path}",
  "email.oauth.jsonParse.fail": "muse setup email: could not use that JSON — {reason}",
  "email.oauth.authUrl": "Open this URL to authorize Gmail access:\n  {url}\n\nWaiting for the browser redirect on {redirectUri} ...",
  "email.oauth.connected": "✓ Gmail connected — the access token now refreshes itself automatically.",
  "email.oauth.connectedAs": "✓ connected as {email}",
  "email.oauth.verifySoftFail": "(saved, but couldn't verify with a live Gmail profile read — try `muse inbox` or `muse doctor` to confirm.)",
  "email.oauth.authFailed": "muse setup email: authorization failed — {reason}",

  "email.authError.appPasswordRequired": "You typed your regular Google sign-in password — this account needs a 16-character app password instead.",
  "email.authError.invalidCredentials": "Google rejected that app password — check it was created for this account and that it was pasted without extra spaces.",
  "email.authError.webLoginBlock": "Google is blocking this sign-in as a security precaution (not a wrong password) — open https://accounts.google.com/DisplayUnlockCaptcha, click Continue, then retry within a few minutes.",
  "email.authError.appPasswordUrlHint": "Create an app password here: {url}",
  "email.authError.serverDetail": "(server said: \"{detail}\")",

  "setup.status.language": "{lang} (via {source})",

  "model.notConfigured": "muse {command} requires a configured model. Run `muse setup local` (or `muse onboard`) to get one, or pass --model.",

  "remind.list.empty": "Reminders ({status}): (none) — add one with `muse remind add \"tomorrow at 6pm\" \"call the dentist\"`",
  "tasks.list.empty": "Tasks ({status}): (none) — add one with `muse tasks add \"<title>\"`",
  "providers.list.empty": "{label}: (none configured) — run `muse doctor` to see what's missing",
  "today.calendar.notConfigured": "\nUpcoming: (calendar not configured — run `muse setup calendar`)\n",
  "today.notes.notConfigured": "\nRecent notes: (notes dir not configured — save your first one with `muse notes save --local <path> \"<text>\"`)\n",

  "remind.add.usage": "usage: muse remind add <when> <text...>\n  e.g. muse remind add \"tomorrow at 6pm\" call the dentist\n  <when> accepts ISO-8601 or a relative phrase: 'tomorrow at 6pm', 'in 3 hours', 'next Monday'",
  "scheduler.add.usage": "usage: muse scheduler add \"<prompt>\" --every \"<cadence>\"\n  e.g. muse scheduler add \"오늘 일정 요약해서 보내줘\" --every \"daily 9am\"",
  "model.use.usage": "usage: muse model use <name>\n  run `muse model list` first to see what's installed.",

  "daemon.status.featuresHeader": "features you can turn on:",
  "daemon.status.ambient.disabled": "ambient rules watch background context and file continuous notices — set MUSE_AMBIENT_RULES to a rules file to turn it on",
  "daemon.status.webWatch.disabled": "web-watch checks configured pages for changes and notifies you — set MUSE_WEB_WATCH_CONFIG to turn it on",
  "daemon.status.homeWatch.disabled": "home-watch checks your Home Assistant devices and notifies you — set MUSE_HOME_WATCH_CONFIG plus your Home Assistant credentials to turn it on",
  "daemon.status.briefing.disabled": "the morning briefing narrates your day in natural language (used by `muse brief`) — set MUSE_BRIEFING_ENABLED to turn it on",
  "daemon.status.selfLearn.disabled": "self-learn distills your usage into lasting playbook/skill improvements — set MUSE_SELFLEARN_ENABLED (and configure a model) to turn it on",
  "daemon.status.recap.disabled": "recap sends an evening summary of what happened today — set MUSE_RECAP_ENABLED to turn it on",
  "daemon.status.digest.disabled": "digest batches anything Muse held back during the day into one evening message — set MUSE_DIGEST_ENABLED=true to turn it back on",
  "daemon.status.msgPoll.disabled": "message-poll checks connected messaging channels for new inbound so it becomes recallable — set MUSE_MESSAGING_POLL_ENABLED to turn it on",
  "daemon.status.conflicts.disabled": "conflict-watch warns you ahead of upcoming double-bookings — set MUSE_CONFLICT_WATCH_ENABLED to turn it on",
  "daemon.status.browsing.disabled": "browsing-sync pulls your Chrome history into recall so Muse can reference pages you've viewed — set MUSE_BROWSING_AUTO_SYNC to turn it on",

  "quiet.notSet": "quiet hours: not set — set with `muse quiet 22:00-07:00`",
  "email.notConfigured": "muse {command}: run `muse setup email` or set MUSE_GMAIL_TOKEN.",
  "listen.notConfigured": "voice providers are not configured. Run `muse setup voice` to check what's missing (or set OPENAI_API_KEY / MUSE_VOICE_OPENAI_API_KEY for the cloud path).",
  "remote.disable.notInstalled": "tailscale isn't installed — nothing to turn off. Install it from {url} if you meant to set up remote access.",

  "serve.notGitCheckout": "muse serve: this install can't self-manage a server — it isn't running from a git checkout of the Muse workspace (no pnpm-workspace.yaml + .git found above the running entry). Nothing was started.\n",
  "serve.distMissing": "muse serve: apps/api/dist/index.js not found under {repoRoot} — build it first with `muse update` (or `pnpm build` in that checkout). Nothing was started.\n",
  "serve.starting": "Starting the Muse API server ({host}:{port}, {repoRoot})…\n  ctrl-c to stop\n",
  "serve.alreadyRunning": "Muse API server is already running at {host}:{port} (pid {pid}, version {version}, since {startedAtIso}) — see `muse serve --status`. Nothing was spawned.\n",
  "serve.alreadyRunning.devVsDevNote": "  (both this CLI and the running server report version \"dev\" — can't tell dev builds apart; pass --replace to force a restart.)\n",
  "serve.foundDifferentBuild": "A Muse API server is already answering at {host}:{port}, but {detail}. Re-run with --replace to shut it down and start this build, or leave it running. Nothing was touched.\n",
  "serve.foundNonMuse": "Something is already listening at {host}:{port} that doesn't look like the Muse API ({detail}). Refusing to touch it — free the port, or bind a different one with --port. Nothing was touched.\n",
  "serve.replacing": "Replacing the running server at {host}:{port}…\n",
  "serve.replaceShutdownFailed": "muse serve --replace: could not replace the running server — {detail}. Nothing was started.\n",
  "serve.exited": "Muse API server exited (code {code}).\n",
  "serve.webDirMissing": "muse serve: apps/web/dist not built under {repoRoot} — the web UI won't be served this run (build it with `muse update`, or `pnpm --filter @muse/web build`). Serving API only.\n",

  "serve.install.platformUnsupported": "muse serve --install is only wired for macOS (launchd) right now — this platform reports '{platform}'. Run `muse serve` directly in the foreground, or use your OS's own service manager to keep it resident.\n",
  "serve.install.written": "Muse API LaunchAgent written and loaded (label: {label}, pid {pid})\n  logs: {logDir}\n  remove with: `muse serve --uninstall`\n",
  "serve.install.failed": "launchctl did not confirm {plistFile} running after load: {detail}\n",
  "serve.uninstall.notInstalled": "Muse API LaunchAgent was not installed at {plistFile} (nothing to remove)\n",
  "serve.uninstall.stillRegistered": "launchctl unload did NOT stop {label} — it is still registered. Keeping {plistFile} so you have a route back. Run `launchctl unload -w {plistFile}` manually, then retry `muse serve --uninstall`.\n",
  "serve.uninstall.removeFailed": "launchctl unload succeeded but failed to remove {plistFile}: {detail}\n",
  "serve.uninstall.removed": "Muse API LaunchAgent unloaded and removed ({plistFile})\n",
  "serve.status.running": "muse serve — running at {host}:{port} (pid {pid}, version {version}, since {startedAtIso})\n",
  "serve.status.notRunning": "muse serve — not running at {host}:{port} (run `muse serve` to start it)\n",
  "serve.status.webUi.serving": "web UI:       served (open http://{host}:{port} in a browser)\n",
  "serve.status.webUi.notServing": "web UI:       not served (build it with `muse update`, then restart `muse serve`)\n",
  "serve.status.webUi.unknown": "web UI:       unknown (couldn't confirm — probe of GET / failed)\n",
  "serve.status.autostartInstalled": "autostart:    installed ({plistFile})\n",
  "serve.status.autostartNotInstalled": "autostart:    not installed (run `muse serve --install`)\n",
  "serve.status.autostartUnsupportedPlatform": "autostart:    not available on this platform ({platform}) — macOS (launchd) only\n",

  "programHttp.serverNotRunning": "Muse API server is not running (tried {baseUrl}) — this command needs it. Start it with `muse serve` (or `muse serve --install` to keep it always-on), point at a running one with --api-url, or check `--help` for this command in case it has a --local (no-server) mode.",
  "programHttp.htmlResponseHint": "Muse API {status} at {baseUrl}: response was HTML, not JSON. The URL probably points at a web server instead of the Muse API — start it with `muse serve`, or pass --api-url <correct url>."
} as const;

export type CliStringKey = keyof typeof en;
type CliStrings = Record<CliStringKey, string>;

const ko: CliStrings = {
  "email.method.prompt": "이메일을 어떻게 연결할까요?",
  "email.method.appPassword.label": "앱 비밀번호 (추천)",
  "email.method.appPassword.hint": "2분이면 끝 — Gmail이나 다른 IMAP 제공자, Google Cloud 프로젝트 불필요",
  "email.method.oauth.label": "구글 OAuth",
  "email.method.oauth.hint": "기존 방식 — Google Cloud 프로젝트 + OAuth 클라이언트가 필요해요",
  "email.setupCancelled": "설정이 취소됐어요.",

  "email.gmail.appPasswordStep": "{email} 계정으로 고정된 앱 비밀번호 생성 페이지를 엽니다 (16자리 비밀번호를 다음 단계에서 붙여넣으세요).\n  {appPasswordUrl}\n2단계 인증이 꺼져 있다면 먼저 켜세요:\n  {twoStepUrl}\n",
  "email.gmail.openBrowserConfirm": "지금 브라우저에서 앱 비밀번호 페이지를 열까요?",
  "email.koWebmail.note": "{label}: 메일 설정에서 IMAP 사용을 켜고, 2단계 인증을 켠 뒤 앱 비밀번호를 발급하세요.",

  "email.prompt.email": "이메일 주소:",
  "email.prompt.email.required": "이메일을 입력해 주세요",
  "email.prompt.email.invalidFormat": "올바른 이메일 주소가 아니에요",
  "email.prompt.appPassword": "앱 비밀번호 (공백은 자동으로 제거돼요):",
  "email.prompt.appPassword.required": "앱 비밀번호를 입력해 주세요",
  "email.prompt.host": "{label} 호스트 (비워두면 제공자 기본값 사용):",

  "email.appPassword.connected": "✓ 연결됨 — 받은편지함에 메시지 {count}개",
  "email.appPassword.verifyFailed": "muse setup email: 연결할 수 없어요 — {detail}",

  "email.oauth.walkthrough": "Gmail 설정 — 브라우저 동의는 한 번만, 이후로는 자동으로 갱신돼요.\n\n  1. https://console.cloud.google.com/apis/library/gmail.googleapis.com 을 열고\n     (프로젝트가 없다면 먼저 만드세요) \"Enable\"을 클릭하세요.\n  2. Google Auth Platform을 여세요: https://console.cloud.google.com/auth/overview\n     처음이라면 \"Get started\"를 클릭하고 앱 이름 + 이메일을 입력하세요\n     (동의 화면의 \"Branding\" 단계예요). \"External\"을 선택하세요.\n  3. 테스트 사용자로 본인을 추가하세요:\n     https://console.cloud.google.com/auth/audience → \"Test users\" → + Add users.\n  4. 클라이언트를 생성하세요: https://console.cloud.google.com/auth/clients\n     \"+ Create client\" → Application type \"Desktop app\".\n  5. 가장 쉬운 방법: 생성 대화상자에서 ⬇를 클릭해\n     client_secret_*.json을 내려받고, 그 파일의 경로를 아래에 붙여넣으세요 — 뮤즈가\n     ID + 비밀키를 파일에서 직접 읽으므로 잘못 붙여넣거나 섞일 일이 없어요.\n     (또는 예전처럼 Client ID와 Client Secret을 직접 복사해도 됩니다.)\n\n  ⚠️  구글은 Client Secret을 그 생성 대화상자에서 딱 한 번만 보여줘요.\n      닫아버렸다면 새 클라이언트를 만드세요 — 나중에는 다시 볼 수 없어요.\n  ⚠️  앱의 게시 상태가 \"Testing\"인 동안은 구글이 refresh token을 7일마다\n      만료시켜요 (이 마법사를 매주 다시 실행해야 해요). 개인용이라면 심사 없이\n      https://console.cloud.google.com/auth/audience 에서 \"Production\"으로\n      게시해서 이를 피할 수 있어요.\n",
  "email.oauth.prompt.clientId": "구글 OAuth Client ID (또는 내려받은 client_secret_*.json 파일 경로):",
  "email.oauth.prompt.clientSecret": "구글 OAuth Client Secret:",
  "email.oauth.jsonRead.ok": "✓ Desktop-app 클라이언트 자격증명을 JSON에서 읽었어요",
  "email.oauth.jsonRead.fail": "muse setup email: {path}을(를) 읽을 수 없어요",
  "email.oauth.jsonParse.fail": "muse setup email: 그 JSON을 쓸 수 없어요 — {reason}",
  "email.oauth.authUrl": "이 URL을 열어 Gmail 접근을 승인하세요:\n  {url}\n\n{redirectUri}로의 브라우저 리디렉션을 기다리는 중...",
  "email.oauth.connected": "✓ Gmail 연결됨 — 액세스 토큰이 이제 자동으로 갱신됩니다.",
  "email.oauth.connectedAs": "✓ {email}(으)로 연결됨",
  "email.oauth.verifySoftFail": "(저장은 됐지만 실제 Gmail 프로필로 검증하지는 못했어요 — `muse inbox` 또는 `muse doctor`로 확인해 보세요.)",
  "email.oauth.authFailed": "muse setup email: 인증 실패 — {reason}",

  "email.authError.appPasswordRequired": "일반 로그인 비밀번호를 입력하셨어요 — 이 계정은 16자리 앱 비밀번호가 필요해요.",
  "email.authError.invalidCredentials": "구글이 그 앱 비밀번호를 거부했어요 — 이 계정용으로 만든 비밀번호가 맞는지, 공백 없이 붙여넣었는지 확인하세요.",
  "email.authError.webLoginBlock": "구글이 보안상의 이유로 이 로그인을 막고 있어요 (비밀번호가 틀린 게 아니에요) — https://accounts.google.com/DisplayUnlockCaptcha 를 열어 Continue를 클릭한 뒤, 몇 분 안에 다시 시도하세요.",
  "email.authError.appPasswordUrlHint": "여기서 앱 비밀번호를 만드세요: {url}",
  "email.authError.serverDetail": "(서버 응답: \"{detail}\")",

  "setup.status.language": "{lang} ({source} 기준)",

  "model.notConfigured": "muse {command}은(는) 모델 설정이 필요해요. `muse setup local`(또는 `muse onboard`)로 모델을 준비하거나 --model을 넘기세요.",

  "remind.list.empty": "리마인더 ({status}): (없음) — `muse remind add \"tomorrow at 6pm\" \"call the dentist\"`로 하나 추가하세요",
  "tasks.list.empty": "할 일 ({status}): (없음) — `muse tasks add \"<제목>\"`로 하나 추가하세요",
  "providers.list.empty": "{label}: (설정된 것 없음) — 무엇이 빠졌는지 `muse doctor`로 확인하세요",
  "today.calendar.notConfigured": "\n다가오는 일정: (캘린더가 설정되지 않음 — `muse setup calendar` 실행)\n",
  "today.notes.notConfigured": "\n최근 노트: (노트 폴더가 설정되지 않음 — `muse notes save --local <경로> \"<내용>\"`로 첫 노트를 저장하세요)\n",

  "remind.add.usage": "사용법: muse remind add <when> <text...>\n  예: muse remind add \"tomorrow at 6pm\" call the dentist\n  <when>은 ISO-8601 또는 상대 표현을 받아요: 'tomorrow at 6pm', 'in 3 hours', 'next Monday'",
  "scheduler.add.usage": "사용법: muse scheduler add \"<prompt>\" --every \"<cadence>\"\n  예: muse scheduler add \"오늘 일정 요약해서 보내줘\" --every \"daily 9am\"",
  "model.use.usage": "사용법: muse model use <name>\n  먼저 `muse model list`로 설치된 모델을 확인하세요.",

  "daemon.status.featuresHeader": "켤 수 있는 선택 기능:",
  "daemon.status.ambient.disabled": "ambient 규칙은 배경 컨텍스트를 지켜보며 지속적인 알림을 남겨요 — MUSE_AMBIENT_RULES에 규칙 파일을 지정하면 켜져요",
  "daemon.status.webWatch.disabled": "web-watch는 지정한 페이지의 변경을 확인해 알려줘요 — MUSE_WEB_WATCH_CONFIG를 설정하면 켜져요",
  "daemon.status.homeWatch.disabled": "home-watch는 Home Assistant 기기를 확인해 알려줘요 — MUSE_HOME_WATCH_CONFIG와 Home Assistant 자격증명을 설정하면 켜져요",
  "daemon.status.briefing.disabled": "아침 브리핑은 하루 일정을 자연어로 요약해요 (`muse brief`에서 사용) — MUSE_BRIEFING_ENABLED를 설정하면 켜져요",
  "daemon.status.selfLearn.disabled": "self-learn은 사용 패턴을 학습해 플레이북/스킬을 지속적으로 개선해요 — MUSE_SELFLEARN_ENABLED를 설정하고(모델도 필요) 켜세요",
  "daemon.status.recap.disabled": "recap은 저녁에 오늘 있었던 일을 요약해서 보내요 — MUSE_RECAP_ENABLED를 설정하면 켜져요",
  "daemon.status.digest.disabled": "digest는 하루 동안 보류된 알림을 저녁 한 번에 모아 보내요 — MUSE_DIGEST_ENABLED=true로 다시 켤 수 있어요",
  "daemon.status.msgPoll.disabled": "message-poll은 연결된 메시징 채널의 새 수신을 확인해 recall 가능하게 만들어요 — MUSE_MESSAGING_POLL_ENABLED를 설정하면 켜져요",
  "daemon.status.conflicts.disabled": "conflict-watch는 다가오는 일정 중복을 미리 경고해요 — MUSE_CONFLICT_WATCH_ENABLED를 설정하면 켜져요",
  "daemon.status.browsing.disabled": "browsing-sync는 Chrome 방문 기록을 recall로 가져와요 — MUSE_BROWSING_AUTO_SYNC를 설정하면 켜져요",

  "quiet.notSet": "무음 시간: 설정 안 됨 — `muse quiet 22:00-07:00`로 설정하세요",
  "email.notConfigured": "muse {command}: `muse setup email`을 실행하거나 MUSE_GMAIL_TOKEN을 설정하세요.",
  "listen.notConfigured": "음성 provider가 설정되지 않았어요. `muse setup voice`로 무엇이 빠졌는지 확인하세요 (또는 클라우드 경로용으로 OPENAI_API_KEY / MUSE_VOICE_OPENAI_API_KEY를 설정하세요).",
  "remote.disable.notInstalled": "tailscale가 설치되어 있지 않아요 — 끌 것이 없어요. 원격 접속을 설정하려던 거라면 {url}에서 설치하세요.",

  "serve.notGitCheckout": "muse serve: 서버를 직접 관리할 수 없어요 — 실행 중인 위치가 Muse 워크스페이스의 git 체크아웃이 아니에요 (실행 파일 상위에서 pnpm-workspace.yaml + .git을 찾지 못했어요). 아무것도 시작하지 않았어요.\n",
  "serve.distMissing": "muse serve: {repoRoot} 아래에서 apps/api/dist/index.js를 찾지 못했어요 — 먼저 `muse update`(또는 해당 체크아웃에서 `pnpm build`)로 빌드하세요. 아무것도 시작하지 않았어요.\n",
  "serve.starting": "Muse API 서버를 시작합니다 ({host}:{port}, {repoRoot})…\n  ctrl-c로 중지\n",
  "serve.alreadyRunning": "Muse API 서버가 이미 {host}:{port}에서 실행 중이에요 (pid {pid}, 버전 {version}, {startedAtIso}부터) — `muse serve --status`로 확인하세요. 아무것도 시작하지 않았어요.\n",
  "serve.alreadyRunning.devVsDevNote": "  (이 CLI와 실행 중인 서버 모두 버전 \"dev\"로 표시돼요 — dev 빌드끼리는 구분할 수 없어요; 강제로 재시작하려면 --replace를 넘기세요.)\n",
  "serve.foundDifferentBuild": "Muse API 서버가 이미 {host}:{port}에서 응답하고 있지만, {detail}. 종료하고 이 빌드로 시작하려면 --replace를 붙여 다시 실행하거나, 그대로 두세요. 아무것도 건드리지 않았어요.\n",
  "serve.foundNonMuse": "{host}:{port}에 이미 Muse API처럼 보이지 않는 다른 무언가가 떠 있어요 ({detail}). 건드리지 않을게요 — 포트를 비우거나 --port로 다른 포트를 지정하세요. 아무것도 건드리지 않았어요.\n",
  "serve.replacing": "{host}:{port}에서 실행 중인 서버를 교체합니다…\n",
  "serve.replaceShutdownFailed": "muse serve --replace: 실행 중인 서버를 교체하지 못했어요 — {detail}. 아무것도 시작하지 않았어요.\n",
  "serve.exited": "Muse API 서버가 종료됐어요 (코드 {code}).\n",
  "serve.webDirMissing": "muse serve: {repoRoot} 아래에 apps/web/dist가 빌드되어 있지 않아요 — 이번 실행에서는 웹 UI를 제공하지 않아요 (`muse update` 또는 `pnpm --filter @muse/web build`로 빌드하세요). API만 제공합니다.\n",

  "serve.install.platformUnsupported": "muse serve --install은 지금은 macOS(launchd)에서만 지원돼요 — 이 플랫폼은 '{platform}'으로 확인됐어요. `muse serve`를 포그라운드로 직접 실행하거나, 이 OS의 서비스 관리자로 상주시키세요.\n",
  "serve.install.written": "Muse API LaunchAgent가 작성되고 로드됐어요 (label: {label}, pid {pid})\n  로그: {logDir}\n  제거: `muse serve --uninstall`\n",
  "serve.install.failed": "launchctl이 {plistFile} 로드 후 실행 중임을 확인하지 못했어요: {detail}\n",
  "serve.uninstall.notInstalled": "{plistFile}에 Muse API LaunchAgent가 설치되어 있지 않아요 (제거할 것이 없어요)\n",
  "serve.uninstall.stillRegistered": "launchctl unload가 {label}을(를) 멈추지 못했어요 — 아직 등록되어 있어요. 되돌아갈 수 있도록 {plistFile}을(를) 남겨뒀어요. `launchctl unload -w {plistFile}`을 직접 실행한 뒤 `muse serve --uninstall`을 다시 시도하세요.\n",
  "serve.uninstall.removeFailed": "launchctl unload는 성공했지만 {plistFile} 제거에 실패했어요: {detail}\n",
  "serve.uninstall.removed": "Muse API LaunchAgent가 언로드되고 제거됐어요 ({plistFile})\n",
  "serve.status.running": "muse serve — {host}:{port}에서 실행 중 (pid {pid}, 버전 {version}, {startedAtIso}부터)\n",
  "serve.status.notRunning": "muse serve — {host}:{port}에서 실행 중이 아니에요 (`muse serve`로 시작하세요)\n",
  "serve.status.webUi.serving": "web UI:       제공 중이에요 (브라우저에서 http://{host}:{port} 열기)\n",
  "serve.status.webUi.notServing": "web UI:       제공하지 않아요 (`muse update`로 빌드한 뒤 `muse serve`를 다시 시작하세요)\n",
  "serve.status.webUi.unknown": "web UI:       확인할 수 없어요 (GET / probe 실패)\n",
  "serve.status.autostartInstalled": "autostart:    설치됨 ({plistFile})\n",
  "serve.status.autostartNotInstalled": "autostart:    설치 안 됨 (`muse serve --install`로 설치하세요)\n",
  "serve.status.autostartUnsupportedPlatform": "autostart:    이 플랫폼에서는 사용할 수 없어요 ({platform}) — macOS(launchd) 전용\n",

  "programHttp.serverNotRunning": "Muse API 서버가 실행 중이 아니에요 ({baseUrl}로 시도함) — 이 명령에는 서버가 필요해요. `muse serve`로 시작하거나 (`muse serve --install`로 항상 켜두거나), --api-url로 실행 중인 다른 서버를 가리키거나, 이 명령에 --local(서버 없이 실행) 모드가 있는지 `--help`로 확인하세요.",
  "programHttp.htmlResponseHint": "Muse API {status} at {baseUrl}: 응답이 JSON이 아니라 HTML이었어요. Muse API가 아닌 다른 웹 서버를 가리키고 있는 것 같아요 — `muse serve`로 시작하거나 --api-url <올바른 URL>을 넘기세요."
};

export const CLI_DICTIONARIES: Record<Lang, CliStrings> = { en, ko };

function fill(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => (name in params ? String(params[name]) : match));
}

let currentLang: Lang = "en";

/** Direct setter — the real CLI startup calls this once via `resolveCliLanguage`; a test that wants a deterministic language without touching the async resolution path calls it directly. */
export function setCliLanguage(lang: Lang): void {
  currentLang = lang;
}

export function getCliLanguage(): Lang {
  return currentLang;
}

/** Sync lookup: missing key in the active language falls back to EN, then (never throwing, never printing "undefined") to the raw key itself. */
export function t(key: CliStringKey, params?: Record<string, string | number>): string {
  const template = CLI_DICTIONARIES[currentLang][key] ?? CLI_DICTIONARIES.en[key] ?? key;
  return fill(template, params);
}

function normalizeLang(value: string | undefined): Lang | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed === "ko" || trimmed === "en" ? trimmed : undefined;
}

/** LANG/LC_ALL/LC_MESSAGES, in that precedence — a Korean-family locale (`ko`, `ko_KR.UTF-8`, …) resolves to `ko`; everything else (including unset) resolves to `en`. */
export function detectLangFromLocale(env: Readonly<Record<string, string | undefined>>): Lang {
  const locale = env.LANG ?? env.LC_ALL ?? env.LC_MESSAGES ?? "";
  return locale.trim().toLowerCase().startsWith("ko") ? "ko" : "en";
}

let cachedResolution: Lang | undefined;

/** Test seam — clears the per-process cache so a test can resolve again under different env/config inputs. */
export function resetCliLanguageCache(): void {
  cachedResolution = undefined;
}

/**
 * Resolution order (AC1): `MUSE_LANG` env > `language` config key > OS
 * locale auto-detect, defaulting to `en`. Resolved once per process and
 * cached — `configRead` (typically `() => readConfigStore(io)`) is only
 * ever awaited on the FIRST call; every call after that returns the
 * cached language synchronously-fast (still a Promise, but no I/O) and
 * `t()` itself stays a plain sync function reading the same cache.
 */
export async function resolveCliLanguage(
  env: Readonly<Record<string, string | undefined>>,
  configRead: () => Promise<{ readonly language?: string }>
): Promise<Lang> {
  // Keep `t()`'s active language in sync even on the cached fast-path — a
  // direct `setCliLanguage` call elsewhere in the process (e.g. a test)
  // must not leave `currentLang` out of step with what this resolver says
  // it resolved to.
  if (cachedResolution) {
    currentLang = cachedResolution;
    return cachedResolution;
  }
  const fromEnv = normalizeLang(env.MUSE_LANG);
  const resolved = fromEnv ?? normalizeLang((await configRead()).language) ?? detectLangFromLocale(env);
  cachedResolution = resolved;
  currentLang = resolved;
  return resolved;
}
