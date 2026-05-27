# Goal 895 — `muse maintenance prune-activity` bounds the unbounded activity log

## Outward change

`muse maintenance prune-activity --keep-days <n>` trims
`~/.muse/activity.jsonl` to a retention window. That file is
append-only — every `muse` chat / ask / status / REPL session stamps
one line via `appendActivity` (`flag: "a"`, no cap, no rotation) — so
it grew **unbounded** forever, and `muse routine` / the pattern
detector read the entire file on every run. `muse maintenance
compact` only handled the rotated `.json.<n>` sidecars, never the
live activity log, so there was no way to bound it. Now an operator
can prune it (default keep 365 days, matching `muse routine`'s max
lookback so a default prune never narrows routine analysis).

## Why this, now

The most-written personal store had no retention story — a genuine
daily-driver disk-growth + read-performance issue (not hypothetical:
`appendActivity` is on the hot path of nearly every command).
`muse maintenance` is the natural home and only handled rotated
sidecars; the live append-only log was the gap. Verifiable, local,
zero-dep, non-rotated surface.

## How

- Pure planner `planActivityPrune(lines, nowMs, keepDays)` →
  `{ keptLines, kept, dropped }`: keeps lines whose `tsIso` parses
  AND is within `keepDays`; drops older lines plus undateable /
  malformed ones (they feed no consumer — `readActivity` already
  skips them — so keeping them would just bloat the file the prune
  exists to bound). Pure over raw lines, so the rewrite logic is
  testable without disk.
- `muse maintenance prune-activity` resolves the path via
  `activityPath()` (honours `MUSE_ACTIVITY_FILE`), reads, plans, and
  on a real run rewrites atomically (tmp + rename, `0o600` — matching
  `appendActivity`). `--dry-run` reports counts without touching
  disk; `--json` emits `{ dropped, kept, keepDays }`; a missing log
  or a no-op prune is reported cleanly. `--keep-days` is
  `parseBoundedInt`-validated (1..3650, default 365).

## Verification

`apps/cli` `program.test.ts`: `planActivityPrune` keeps the in-window
line and drops the old + undateable + malformed ones (blank ignored);
an integration test seeds a temp `MUSE_ACTIVITY_FILE` (old, recent,
old), runs `prune-activity --keep-days 30 --dry-run` (asserts "would
drop 2 of 3" AND the file is untouched — still 3 lines), then the
real run (asserts "Pruned 2 line(s); kept 1" AND the file now holds
only the in-window line). Mutation-proven: making the planner keep
every line fails both tests. The 2 full-suite failures are the known
voice-playback `/tmp` flake; `pnpm lint` 0/0. No LLM path → no
smoke:live (Ollama down regardless).

## Decisions

- Default 365 days, not a tighter window: `muse routine` reads up to
  365 days, so a default prune must not silently truncate routine
  analysis; operators who want aggressive pruning pass a smaller
  `--keep-days`.
- Drops undateable lines rather than keeping them: a retention prune
  should produce a clean bounded file, and undateable lines
  contribute nothing to any consumer.
