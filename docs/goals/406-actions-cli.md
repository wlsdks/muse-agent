# 406 — `muse actions` — the P6 accountability read surface

## Why

P6-b1's bullet is "a reviewable action log records every
autonomous action … **queryable by the user**." Goal 405 made the
objectives daemon append its autonomous actions to that log, but a
grep confirmed there was **no `muse actions` CLI** — `queryActionLog`
existed with no user surface. Accountability the user cannot read
is not accountability; this is the missing read half of a
P6-mandated promise, completing it end-to-end.

(Step-1 / anti-concentration note: the recent ~13 iterations
clustered in objectives/autonomy. I first investigated a genuinely
different area — whether the agent reply path leaks `<think>` from
the mandated qwen3 model — and found it already robustly stripped
in BOTH model adapters, stream + non-stream, so hardening there
would have been gold-plating. `muse actions` is adjacent to the
recent cluster but is a distinct small user-facing READ surface
that completes a P6-mandated user promise — high value, not
low-value churn; recorded transparently.)

## Slice

- `apps/cli/src/commands-actions.ts` —
  `registerActionsCommands(program, io)`: lean local-mode
  `muse actions` over the same `~/.muse/action-log.json` the
  daemon writes (`queryActionLog` + `resolveActionLogFile`, no API
  server needed), mirroring the `muse objectives` (404) template:
  - newest-first listing with rationale
    (`<when> [<result>] <what> (<objectiveId>) — <why> — <detail>`),
  - `--user <id|all>` (default `local`, matching
    `muse objectives`), `--result performed|refused|failed|all`
    (closest-match hint on a typo), `--limit <n>` (default 20,
    positive-int validated),
  - friendly `No recorded actions.` when empty.
- Registered in `program.ts` beside `muse objectives`.

## Verify

- `@muse/cli` commands-actions.test.ts 5/5: newest-first +
  rationale; empty → friendly message (not an error);
  `--result` filter + `--user` scope (default `local`, `all`
  shows every bucket); `--limit` caps the newest-first slice;
  unknown `--result` → hint + exit 1, non-positive `--limit` →
  exit 1.
- Cross-package (cli ← @muse/autoconfigure resolver + @muse/mcp
  store), so `pnpm check` (dependency-order build+test) is the
  gate: green across all workspaces (apps/cli 701, all packages);
  `pnpm lint` 0/0; `pnpm guard:core` clean; tsc strict clean.
- No request/response (LLM) path — local store read + commander
  wiring; no smoke:live applies.

## Status

Done. The user can now run `muse actions` and see exactly what
Muse did autonomously on their behalf — what / why / when /
result / objective — closing P6-b1's "queryable by the user"
promise end-to-end (405 logs; 406 reads). One CAPABILITIES line
appended citing P6-b1 (the read surface its check implied). No
OUTWARD-TARGETS flip — P6-b1 was already `[x]` on its store
integration; this adds the genuine user surface, recorded
honestly, same discipline as goals 404/405.

## Decisions

- Investigated a different area first (model `<think>` leakage)
  and found it solid — avoided gold-plating / duplicate work, the
  same probe-before-acting discipline established in goals
  401/403. Then chose the highest-leverage real gap.
- `--user` default `local` matches `muse objectives` so a
  CLI-registered objective's daemon actions are visible by default
  without flags; `--user all` for the full picture.
- Local-mode only (remote/API/`--json` are thin deferred
  follow-ups, deliberately not bundled) — tight scope, mirrors how
  `muse tasks` / `muse objectives` started.
- CAPABILITIES line, no bullet flip: a genuine new user-exercisable
  surface but nothing in OUTWARD-TARGETS was unmet — recorded
  honestly, not a false metric.
