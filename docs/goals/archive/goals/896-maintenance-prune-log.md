# Goal 896 — `muse maintenance prune-log` bounds the unbounded notification log

## Outward change

`muse maintenance prune-log --keep-days <n>` trims
`~/.muse/notifications.log` to a retention window. That file is the
sink of the `log` messaging provider — the **default** proactive
delivery channel when no Telegram/Discord/Slack token is set, i.e.
the path a zero-cost local user actually hits — and it was pure
append (`flag: "a"`, no cap/rotation). Every proactive notice / log
send appended a `[<ISO>] (<dest>) <text>` line forever. Now it can be
pruned by date (default keep 90 days), completing the retention story
895 started for `activity.jsonl`.

## Why this, now

895 bounded `activity.jsonl`; surveying the *other* append-only
stores per that thread, `last-chat.jsonl` has an auto-compactor and
`reminder-history`/`episodes` are capped — but `notifications.log`
had no retention at all, and it's on the proactive hot path for
token-less users. Same real unbounded-growth class.

## How

- Generalised 895's planner into `planTimestampedLinePrune(lines,
  nowMs, keepDays, extractTsMs)` — the by-date keep/drop logic with a
  pluggable per-line timestamp extractor. `planActivityPrune` now
  delegates with a JSON-`tsIso` extractor (behaviour-preserving — 895
  tests stay green); the new `planNotificationLogPrune` delegates
  with a leading-`[ISO]` bracket extractor.
- Extracted a shared `runFilePrune(file, keepDays, planner, options,
  missingLine)` (read → plan → dry-run report OR atomic tmp+rename
  rewrite, `0o600`) that both `prune-activity` and the new
  `prune-log` use — collapsing the duplicated read/rewrite block.
- `muse maintenance prune-log` resolves the path via
  `MUSE_MESSAGING_LOG_FILE` (matching `muse status`), default 90 days.

## Verification

`apps/cli` `program.test.ts`: `planNotificationLogPrune` keeps an
in-window `[ISO] (dest) text` line and drops an old one + an
un-bracketed line; an integration test seeds a temp
`MUSE_MESSAGING_LOG_FILE`, asserts `prune-log --dry-run` reports
"would drop 2 of 3" and leaves the file untouched, then the real run
rewrites to just the in-window line. The 895 `prune-activity` tests
stay green through the shared planner + helper. Mutation-proven:
neutralising the `[ISO]` extractor fails both new tests. The 2
full-suite failures are the known voice-playback `/tmp` flake; `pnpm
lint` 0/0. No LLM path → no smoke:live (Ollama down regardless).

## Decisions

- Default 90 days (vs prune-activity's 365): the notification log is
  a human audit trail with no downstream consumer of old lines (only
  `muse status` reads the last line + byte size), so a tighter
  default is safe; `activity.jsonl` feeds `muse routine`'s up-to-365d
  window, so it needs the longer default.
- Generalised the planner rather than copying it — the second
  by-date prune made the shared extractor-parameterised version the
  honest factoring (it rides this capability, isn't churn for its
  own sake).
