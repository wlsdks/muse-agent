# desktop-enhance — loop journal

Theme: harden & enrich the macOS desktop app (`apps/desktop`) — companion
character interaction, menu bar, Settings, self-contained server supervision,
WKWebView, bundled web UI (the app renders `apps/web` in a WebView), onboarding,
accessibility, Swift 6 concurrency, code quality, tests. Tier2 (push to
`loop/desktop-enhance` + draft PR; never auto-merge to main). Isolated worktree
`/tmp/muse-desktop-enhance`. Browser-measured UI verification (④c) on any
web/view change. Narrowest-test-only policy.

## fire 1 · 2026-06-22 · skill v2.1.0 · (pending commit)
meta: value-class=companion-interaction-quality · area=companion · kind=refactor+feature · verdict=PASS · firesSinceDrill=1
ratchet: testFiles +1 (IdleChatterTests, 9 cases) · companion×refactor 1 · fabrication 0
browser-check: n/a (Swift-only; idle chatter has no DOM render)

- **What**: extracted the idle-chatter policy out of `CompanionModel` (untestable
  @MainActor AppKit) into a pure, headless-testable `IdleChatter` enum in
  `MuseDesktopCore` — `nextCannedLine` (avoids an immediate repeat of the last
  shown line) and `acceptThought` (keeps the old empty/>160/"i'm not sure"/"잘
  모르" gates AND adds: drop punctuation-only junk, drop a near-duplicate of the
  last ≤4 shown lines). Wired in via a `recentIdle` ring buffer.
- **Why**: Jinan asked the companion to "talk more, and say its own genuine
  thoughts." More frequent chatter (already 150s→45s) feels robotic if the local
  8B keeps returning the same greeting; the dedup + no-repeat make the higher
  cadence feel alive instead of stuck.
- **Review point**: `acceptThought` is strictly stricter than the old inline
  filter (no good line newly rejected; only junk/duplicates dropped) — confirmed
  by the independent Opus ④b judge tracing OLD vs NEW.
- **Risk**: low — pure logic + additive wiring; companion bubble lifecycle
  (16s auto-clear, `lastIdleText`/`showingIdleLine`) untouched. No security
  surface.

mutation-first: breaking the avoid-repeat guard AND the dedup guard each turned a
test RED (2 failures); restored → 9/9 GREEN. ④b independent Opus judge: PASS.

## fire 2 · 2026-06-22 · skill v2.1.0 · (pending commit)
meta: value-class=settings-input-correctness · area=settings · kind=feature · verdict=PASS · firesSinceDrill=2
ratchet: testFiles +1 (apiUrl.test.ts, 7 cases) · companion×refactor 1 · settings×feature 1 · fabrication 0
browser-check: Settings — invalid(ftp)→Save disabled+error; schemeless(127.0.0.1:3030)→enabled+normalized; empty→disabled; .content bounded(≤viewport) & scrolls; nav-icon 16px; no new JS console errors

- **What**: new pure `normalizeApiBaseUrl` (apps/web/src/lib/apiUrl.ts) + 7 tests,
  wired into Settings → Save is disabled on an invalid API URL, shows an inline
  error, and saves the NORMALIZED url (adds default http:// scheme, strips
  trailing slash, rejects non-http schemes / hostless garbage).
- **Why**: the API client builds every request with `new URL(path, baseUrl)`, so
  a base typed without a scheme ("127.0.0.1:3030") silently breaks every call —
  this catches a mistyped URL at save time instead of failing every request.
- **Review point**: scheme-guard order (reject non-http → prepend http:// →
  parse → hostname check) — independent Opus ④b judge executed it (incl.
  javascript:/data: → rejected) and traced no join/display regression.
- **Risk**: low — pure helper + Settings save-path only; absolute API paths mean
  trailing-slash strip can't change request joining. No security surface.

mutation-first: removing the scheme-prepend turned 1 test RED; restored → 7/7
GREEN. ④b independent Opus judge: PASS (nit: doc-comment style → fixed).

## fire 3 · 2026-06-22 · skill v2.1.0 · (pending commit)
meta: value-class=server-resilience · area=server · kind=refactor · verdict=PASS · firesSinceDrill=3
ratchet: testFiles +1 (RestartPolicyTests, 4 cases) · companion×refactor 1 · settings×feature 1 · server×refactor 1 · fabrication 0
browser-check: n/a (Swift-only; server supervision has no DOM)

- **What**: extracted the bundled-server restart/backoff decision out of the
  untestable `ServerManager` singleton into a pure `MuseDesktopCore.RestartPolicy`
  + 4 tests, and switched LINEAR backoff (restarts×1.5) to EXPONENTIAL with a cap
  (baseDelay×2^n, capped at maxDelay) keeping the 3-restart circuit breaker.
- **Why**: a crash-looping server binary should back off fast and then stop
  hot-spinning; exponential-with-cap is the standard, and the policy is now
  unit-testable instead of buried in Process plumbing.
- **Review point**: semantic equivalence of the rewrite — still exactly 3
  restarts then give up, `restarts += 1` only on the .restart branch, breaker
  resets via ensureRunning. Independent Opus ④b judge ran 3 mutations (linearize,
  no-cap, off-by-one breaker) — all caught — and confirmed env injection / stop()
  / restart() untouched.
- **Risk**: low — pure policy + one switch in handleExit; env/Keychain plumbing
  byte-identical. No security surface.

mutation-first: linearizing the exponent turned 2 tests RED; restored → 4/4
GREEN. ④b independent Opus judge: PASS.

## fire 4 · 2026-06-22 · skill v2.1.0 · (pending commit)
meta: value-class=palette-search-quality · area=web · kind=ux · verdict=PASS · firesSinceDrill=4
ratchet: testFiles +1 (commandFilter.test.ts, 7 cases) · companion×refactor 1 · settings×feature 1 · server×refactor 1 · web×ux 1 · fabrication 0
browser-check: palette opened, 16 cmds on empty query; real-title substring "오늘"→1 (contains probe); bogus→0; live filter; no new JS console errors

- **What**: extracted the command-palette filter into a pure `rankCommands`
  (apps/web/src/components/commandFilter.ts) + 7 tests, upgrading a flat
  substring filter to ranked matching (title-prefix > title-substring > group >
  fuzzy subsequence), multi-term AND, stable tie order. Wired CommandPalette to it.
- **Why**: the old filter was substring-only and order-insensitive — "stng"
  wouldn't find "Settings", and a prefix hit didn't rank above a mid-string one.
  Better palette search = faster keyboard navigation.
- **Review point**: ranking changes result ORDER while the component's index nav
  relies on `filtered` — index resets on open and clamps on length change, length
  is stable across reorder, Enter is guarded. Independent Opus ④b judge ran the
  ranking mutation itself + tested isSubsequence directly; confirmed no false
  subsequence match and stable tie-break.
- **Risk**: low — pure helper + one useMemo swap; a11y attributes untouched. No
  security surface.

mutation-first: changing the prefix score 100→60 turned the ranking test RED;
restored → 7/7 GREEN. ④b independent Opus judge: PASS.

## fire 5 · 2026-06-22 · skill v2.1.0 · (pending commit)
meta: value-class=shipped-asset-integrity · area=tests · kind=test · verdict=PASS · firesSinceDrill=5
ratchet: testFiles +1 (MuseSpriteTests, 6 cases) · companion×refactor 1 · settings×feature 1 · server×refactor 1 · web×ux 1 · tests×test 1 · fabrication 0
browser-check: n/a (Swift unit test only)

- **What**: added the only missing MuseDesktopCore test class — MuseSpriteTests —
  validating the integrity of the SHIPPED mascot `MuseSprite.default` (rectangular
  rows, palette covers every cell, valid hexes, dims match declared w/h, animation
  override rows in range + width-matched + palette-mapped). Test-only, no source change.
- **Why**: the renderer SILENTLY skips unmapped glyphs / unparseable hexes, so a
  hand-edited ASCII-art row or a typo'd palette key would ship a holed/skewed
  mascot with no crash and nothing else catching it. MuseSprite was the last
  untested Core type.
- **Review point**: pins ACTUAL shipped data, not a fixture. Independent Opus ④b
  judge ran 5 mutations (ragged row, unmapped grid char, out-of-range mouth index,
  short override row, unmapped override char) — each caught by the precise test.
- **Risk**: none — test-only, no shipped-code change, no security surface.

EXHAUSTION note: after this, every MuseDesktopCore type has a test class — the
"add Core coverage" vein is dry; next tests-area work should target web (vitest)
or a new behavior, not more Core coverage.
lesson (process): initial pick duplicated VoiceGateTests (VoiceGate was already
tested inside PresentationTests.swift); the file-name-based untested scan missed
it. Caught at compile (redeclaration), deleted, repointed to MuseSprite. Grep for
the test CLASS, not the file name, when assessing coverage.

mutation-first: truncating a shipped grid row turned 2 tests RED; restored → 6/6
GREEN. ④b independent Opus judge: PASS.

## fire 6 · 2026-06-22 · skill v2.1.0 · (pending commit)
meta: value-class=companion-presence · area=companion · kind=feature · verdict=PASS · firesSinceDrill=6
ratchet: testFiles +0 (added 3 cases to IdleChatterTests) · companion×refactor 1 · companion×feature 1 · settings×feature 1 · server×refactor 1 · web×ux 1 · tests×test 1 · fabrication 0
browser-check: n/a (Swift-only; companion bubble has no DOM)

- **What**: `IdleChatter.timeGreeting(hour:language:)` — a time-of-day opening line
  (morning 5–11 / afternoon 12–17 / evening 18–22 / late-night 23–4), localized
  KO/EN, hour normalized defensively. Wired so the companion's FIRST line of a
  session is the time greeting, then the existing cycle.
- **Why**: Jinan wants the companion to feel present and say genuine things — a
  generic "Hi" every launch feels canned; a greeting that matches the actual hour
  reads as alive.
- **Review point**: 24-hour bucket exhaustiveness (disjoint, no gap) + the
  showIdleLine first-line branch keeps idleLineIndex/recentIdle/auto-clear
  invariants. Independent Opus ④b judge walked all 24 hours + confirmed wiring.
- **Risk**: low — pure fn + one branch in showIdleLine; bubble lifecycle intact.
  No security surface.

mutation-first: shifting the morning bucket 5...11→6...11 turned the boundary
test RED; restored → 12/12 GREEN. ④b independent Opus judge: PASS.

## fire 7 · 2026-06-22 · skill v2.1.0 · (pending commit)
meta: value-class=i18n-completeness · area=web · kind=i18n · verdict=PASS · firesSinceDrill=7
ratchet: testFiles +1 (autonomy-labels.test.ts, 4 cases) · companion×refactor 1 · companion×feature 1 · settings×feature 1 · server×refactor 1 · web×ux 1 · web×i18n 1 · tests×test 1 · fabrication 0
browser-check: Automation 뷰 — 탭(액션 로그/목표/회피) 렌더, raw i18n 키 누출 0, .content bounded+scroll, nav-icon 16px, 신규 콘솔에러 0 (배지 텍스트는 서버데이터 필요 → 단위테스트로 매핑 커버)

- **What**: localize the Automation view's status badges — pure `actionResultLabel`
  / `objectiveStatusLabel` (reuse actstatus.* for results; new auto.status.active/
  done + auto.vetoBadge, en+ko) replacing raw `{a.result}`/`{o.status}`/`veto`.
- **Why**: those badges showed raw English in an otherwise-Korean UI — a visible
  i18n gap (Jinan cares about the KO surface). Unknown values fall back to raw
  (forward-compatible).
- **Review point**: tone functions still key off the RAW status (color correct),
  only the label is localized; i18n parity holds (both locales got the new keys).
  Independent Opus ④b judge ran both mapping mutations + the default-branch
  mutation, confirmed parity/tone/type-safety.
- **Risk**: low — pure helpers + 3 badge swaps + 6 i18n strings. No security surface.

mutation-first: flipping performed→refused key turned a mapping test RED;
restored → 4/4 GREEN. ④b independent Opus judge: PASS.

NOTE: fire 8 will hit consecutive-allPASS≥8 → JUDGE-DRILL required next fire.

## fire 8 · 2026-06-22 · skill v2.1.0 · (pending commit) · ★JUDGE-DRILL
meta: value-class=a11y-keyboard-nav · area=web · kind=a11y · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: testFiles +1 (tabKeyNav.test.ts, 6 cases) · companion×refactor 1 · companion×feature 1 · settings×feature 1 · server×refactor 1 · web×ux 1 · web×i18n 1 · web×a11y 1 · tests×test 1 · fabrication 0
browser-check: Automation — role="tablist" + 3 role="tab", exactly 1 aria-selected, ArrowRight moved selection 0→1, .content bounded+scroll, nav-icon 16px, no new console errors

★JUDGE-DRILL (consecutive allPASS≥8 trigger): first submitted a DELIBERATELY VACUOUS
test for nextTabIndex (asserted only "returns a number" / "in range" — passes
regardless of the mapping). The independent Opus ④b verifier correctly **FAILED**
it, naming each vacuous assertion + exactly what a real test must assert and which
one-line mutations it must catch. Proves the verifier is fail-close / not a
rubber-stamp. Then rolled the test back and shipped the REAL value-pinned version.

- **What**: accessible WAI-ARIA tablist for the Automation tabs — pure
  `nextTabIndex(current,key,count)` (arrow wrap / Home / End) + role="tablist" /
  role="tab" / aria-selected / roving tabIndex / onKeyDown wiring.
- **Why**: the tabs were plain `<button>`s — no role, no keyboard arrow nav, no
  selected-state for assistive tech. Now keyboard + screen-reader navigable.
- **Review point**: `TABS[next]` access guarded (noUncheckedIndexedAccess on);
  onClick + .active preserved; localized labels (fire 7) intact. ④b ran its own
  second mutation (Home→count-1) → caught.
- **Risk**: low — pure helper + ARIA attrs. No security surface.
- **follow-up ◦**: focus does not yet move to the newly-selected tab on Arrow
  (roving-tabindex focus-follow) — non-blocking per ④b; APG-conformance nit →
  backlog.

mutation-first: flipping ArrowRight direction → 2 RED; restored → 6/6 GREEN.
④b independent Opus judge: DRILL=FAIL-as-expected, REAL=PASS.

## fire 9 · 2026-06-22 · skill v2.1.0 · (pending commit)
meta: value-class=menu-status-correctness · area=menu · kind=refactor · verdict=PASS · firesSinceDrill=1
ratchet: testFiles +1 (MenuStatusTests, 3 cases) · companion×refactor 1 · companion×feature 1 · settings×feature 1 · server×refactor 1 · web×ux 1 · web×i18n 1 · web×a11y 1 · tests×test 1 · menu×refactor 1 · fabrication 0
browser-check: n/a (Swift-only; menu bar has no DOM)

- **What**: extracted MuseController.statusTitle's logic into a pure
  MuseDesktopCore.MenuStatus — shortModelName (last path segment), isLocalOnly
  (MUSE_LOCAL_ONLY parse, default-on, only "false" disables), line (compose).
- **Why**: the menu-bar status line (privacy posture · model · server) had its
  model-shortening + env parse buried in AppKit, untestable. The privacy-posture
  read especially deserves a pinned test (a drift to "only 'true' is on" would
  wrongly show a cloud posture in the menu).
- **Review point**: byte-identical output to the old inline code (same default
  model, " · " separator, shortening, literal-"false"-only disable); Core stays
  headless (labels resolved in AppKit). Independent Opus ④b judge confirmed exact
  semantic equivalence + ran its own 2nd mutation (== "true").
- **Risk**: none — behavior-preserving; reads env for display only, the real
  local-only gate is untouched. No security surface.

mutation-first: .last→.first turned 3 tests RED; restored → 3/3 GREEN.
④b independent Opus judge: PASS.

## fire 10 · 2026-06-22 · skill v2.1.0 · (pending commit)
meta: value-class=onboarding-guidance-correctness · area=onboarding · kind=refactor · verdict=PASS · firesSinceDrill=2
ratchet: testFiles +1 (OnboardingGuidanceTests, 4 cases) · companion×refactor 1 · companion×feature 1 · settings×feature 1 · server×refactor 1 · web×ux 1 · web×i18n 1 · web×a11y 1 · tests×test 1 · menu×refactor 1 · onboarding×refactor 1 · fabrication 0
browser-check: n/a (Swift-only; onboarding is AppKit/SwiftUI)

- **What**: extracted first-run onboarding's fix-it guidance out of OnboardingWindow
  into a pure MuseDesktopCore.OnboardingGuidance.text(for:korean:) + 4 tests;
  removed the inline private duplicate.
- **Why**: the guidance that tells a new user how to fix a not-ready local AI
  (run `ollama serve` / `ollama pull <model>`) is the first-run success path — the
  model-missing case interpolates the exact model id the user copy-pastes, so it
  must be precise and was previously untestable inside SwiftUI.
- **Review point**: byte-identical strings to the old inline code (both langs, all
  3 OllamaStatus cases); exhaustive switch (no default masking a future case).
  Independent Opus ④b judge confirmed equivalence + grep'd no dead duplicate.
- **Risk**: none — display copy only, behavior-preserving. No security surface.

mutation-first: hardcoding the model in the pull command turned 3 tests RED;
restored → 4/4 GREEN. ④b independent Opus judge: PASS.
