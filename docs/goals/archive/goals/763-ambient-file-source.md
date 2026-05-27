# 763 — feat: file-backed ambient signal source + rules parser (P20 perception wiring)

## Why

756 proved ambient-signal → proactive notice with a SIMULATED source.
The production gap was a real, dog-food-able way to feed the ambient
signal without a native OS dependency. A JSON file an external helper
writes (`~/.muse/ambient.json`, e.g. a launchd/cron one-liner dumping
the frontmost app + window title) is zero-dep, local, and testable.

## Slice

`@muse/mcp` ambient-notice-loop.ts:
- `FileAmbientSignalSource(file)` — an `AmbientSignalSource` that reads
  + parses the ambient JSON file into the string signal fields (app /
  window / selected / clipboard / notifications). Fail-open: missing /
  malformed / empty → `undefined` (no notice), never throws.
- `parseAmbientNoticeRules(raw)` — parse a JSON array of notice rules
  from config; each needs a non-empty `id`, string `title`/`message`,
  and ≥1 `match` field (a pattern-less rule is dropped — it would fire
  on everything). Fail-open: malformed / non-array / invalid entry
  skipped.

Together these turn `runAmbientNoticeTick` (756) into something a real
deployment can run: a file source + config rules + the proactive sink.

## Verify

- `@muse/mcp` ambient-file-source.test.ts (new, 5) against REAL temp
  files:
  - `FileAmbientSignalSource` reads string fields (drops a non-string
    field); fail-open on missing file / malformed JSON / empty object.
  - `parseAmbientNoticeRules` parses a valid rule and DROPS invalid /
    pattern-less / id-less entries; malformed JSON / non-array → [].
  - **end-to-end**: a real `ambient.json` (window "Team Standup")
    parsed rules → `runAmbientNoticeTick(FileAmbientSignalSource …)`
    delivers the notice through a real `ProactiveNoticeSink`.
- **Mutation-proven**: removing the pattern-less-rule skip in
  `parseAmbientNoticeRules` lets an invalid rule leak → the parse test
  fails; restore → 5/5.
- Full `pnpm check` EXIT 0 (mcp 698, every workspace green); `pnpm
  lint` 0/0. File IO + deterministic logic, no model path → no
  `smoke:live`.

## Decisions

- **File-backed source, not a native OS reader** — zero native
  dependency, dog-food-able (write the file in a test), and the
  OS-specific capture (osascript / xdotool) stays a user-owned helper
  script that just writes the file. Fail-open everywhere so a missing
  helper never breaks the tick.
- No bullet flip — P20 perception is already `[x]` (756, simulated
  signal which is the bullet's stated check); this is the real-source
  production wiring (CAPABILITIES line). Scheduling
  `runAmbientNoticeTick` as an apps/api daemon (env-gated, with
  fired-rule persistence) is the remaining thin follow-on.
