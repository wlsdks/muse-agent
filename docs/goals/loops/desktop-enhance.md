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
