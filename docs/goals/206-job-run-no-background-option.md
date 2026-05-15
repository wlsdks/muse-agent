# 206 — `muse job run --no-background` (advertised inline mode was broken)

## Why

Flagged out-of-scope in goal 205 and confirmed: the option was

```ts
.option("--background", "Detach the worker. Default ON; pass --no-background to run inline.", true)
```

Commander only auto-creates the `--no-X` negation when the
option is declared as `.option("--no-X", …)` (or is a plain
boolean). Declaring `.option("--background", …, true)` creates
**only** a `--background` flag defaulting to `true`; it does
**not** create `--no-background`. So the inline mode the help
text explicitly advertises — "pass --no-background to run
inline" — was rejected at parse time:

```
error: unknown option '--no-background'
(Did you mean --background?)        exit 1
```

The entire documented inline-execution path
(`commands-jobs.ts:229 if (options.background === false)`) was
**unreachable** — dead code guarded by a flag the parser
refused. The same command already had the correct idiom one
line below (`.option("--no-tools", …)` read as
`options.tools === false`), so this was an inconsistency, not
a hard design constraint.

## Scope

- `apps/cli/src/commands-jobs.ts`: declare the option the
  Commander-idiomatic way —
  `.option("--no-background", "Run the worker inline … Default:
  detached.")`. `options.background` still defaults to `true`
  and becomes `false` on `--no-background`, so the existing
  action code (`options.background === false`, the
  `background?: boolean` type) is unchanged — this exactly
  mirrors the sibling `--no-tools`. No code passes `--background`
  explicitly (only doc comments did).
- Corrected the now-inaccurate `--background` references in the
  `commands-jobs.ts` module doc and the `job-worker.ts` header
  (they advertised a flag that never existed).
- `apps/cli/test/program.test.ts`: deterministic regression
  test — `job run --no-background ""` resolves to the empty-
  prompt usage guard (option recognized, no "unknown option",
  exit 1, no worker spawned), plus a control proving an
  actually-unknown `--no-bogus` still rejects.

## Verify

- `pnpm --filter @muse/cli test` — 508 pass (1 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Real-LLM path (inline mode spawns the worker) → dog-fooded
  on real Qwen (ollama/qwen3:8b, reasoning off):
  `muse job run --no-background --no-tools "Reply with exactly:
  PONG"` → previously: `error: unknown option
  '--no-background'`, exit 1. Now: prints `Done. Job log: …`,
  exit 0, JSONL `started → progress("P") → progress("ONG") →
  done` — the inline worker ran through Qwen end-to-end.

## Status

done — the advertised `muse job run --no-background` inline
mode is no longer dead: the flag parses, the inline-execution
branch is reachable, and it runs the worker through Qwen
synchronously as documented.
