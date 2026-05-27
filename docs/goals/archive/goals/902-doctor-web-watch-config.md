# Goal 902 — `muse doctor --local` validates the web-watch config

## Outward change

`muse doctor --local` now reports on `MUSE_WEB_WATCH_CONFIG` (the
"monitor this page, ping me when X" automation): a `web-watch config`
check that says `N page-watch(es) configured` (ok) or, when entries
are malformed, `M of K web-watch entries are invalid and skipped —
check id/url/title/message/rule` (warn). Before, a user who set up a
watch with one JSON typo (missing `url`, an empty `rule`, broken
JSON) got **no notice and no error** — the daemon parses the config
fail-open and silently drops the bad entry, so the watch just never
fires and nothing tells them why. The diagnostic now surfaces the
silent drop the user can't otherwise see.

## Why this, now

A real "why isn't it firing?" support trap, the same class 887 (silent
piper→paid fallback) and 899 (silent DND) closed. Web-watch is the P21
proactive-perception surface, and its config is the one place a typo
produces zero feedback. `muse doctor` is exactly where a user checks
"is my setup actually working?" — and it was blind to the automation
config. Fresh surface (doctor), squarely in the P20/P21 perception
direction, verifiable fully offline.

## How

New pure `classifyWebWatchConfig(raw)`:
- unset / whitespace / empty array → `undefined` (no check, no noise);
- not valid JSON → warn "set but not valid JSON — no pages are being
  watched"; not a JSON array → warn "must be a JSON array";
- otherwise compares the raw entry count to the count
  `webWatchesFromConfig` actually builds, reporting `ok` when equal or
  `warn` quantifying the drop (singular/plural phrasing).

It drives the REAL `@muse/mcp` `webWatchesFromConfig` parser for the
valid count (not a re-implementation) so the diagnostic can't drift
from what the daemon builds. A no-op Chrome connection is passed so a
legitimate `source: "chrome"` entry counts as valid rather than being
dropped for lack of a live browser in the doctor process.
`runLocalDoctor` pushes the check only when the env is set.

## Verification

`apps/cli` `commands-doctor.test.ts` (`npx vitest run --root apps/cli
commands-doctor.test.ts`, 30 passing): unset/empty→undefined; all-valid
→ ok+count; chrome-source entry counts valid; mixed → warn "2 of 3 …
invalid"; single drop → singular "1 of 2 … entry is invalid"; bad-JSON
and non-array → warn. Mutation-proven: forcing `valid = total` (pretend
nothing dropped) fails the two drop-quantifying tests; restored green.
`pnpm lint` 0/0. apps/cli alone fully green (145 files / 1578 tests);
the 2 failures under parallel `pnpm check` are the known voice-playback
`/tmp` race flake (passes in isolation, 12/12). No LLM path → no
smoke:live (Ollama down regardless).

## Decisions

- Reused `webWatchesFromConfig` to count validity rather than
  re-deriving per-entry rules in the doctor — a second copy of the
  validity logic would silently disagree with the daemon the first
  time either changed.
- `warn`, not `fail`, for a broken watch config: web-watch is opt-in
  automation, not a core-CLI prerequisite, so a typo shouldn't flip
  the whole doctor verdict to fatal — but it must be visible.
- Only emit the check when the env is set, keeping the default
  doctor output focused for the majority who don't use web-watch.
