# 404 — `muse objectives` CLI — the user entry point to delegated autonomy

## Why

The entire P5→P9 delegated-autonomy chain — durable objectives
store (P5-b1), tick re-evaluation + backoff/escalation (P5-b2),
consented action (P5-b3), the accountability log + veto loop
(P6/P7), the objectives daemon + model evaluator running in a real
server (P9) — was built and audited. But a grep confirmed there
was **no `muse objectives` CLI command**: the user had no entry
point to actually *register* a standing objective. The deep
substrate was unreachable in practice. This closes the most
load-bearing usability gap, in a deliberately different area from
the recent briefing / P7-prod / evaluator-robustness iterations
(Step-8 anti-concentration).

## Slice

- `apps/cli/src/commands-objectives.ts` —
  `registerObjectivesCommands(program, io)`: a lean **local-mode**
  command group over the shared `~/.muse/objectives.json` (the
  same file the P9 objectives daemon ticks, so a CLI-registered
  objective is picked up on the next tick — no API server needed):
  - `muse objectives add <spec…> [--kind watch|until|notify]
    [--user <id>]` → `addObjective` with a fresh `obj_<uuid>`,
    `active` status; invalid `--kind` gets a closest-match hint
    (the established `commands-tasks` pattern).
  - `muse objectives list [--status active|done|escalated|
    cancelled|all] [--user <id>]` → `readObjectives`, user-scoped,
    `No objectives.` when empty.
  - `muse objectives cancel <id>` → `patchObjective` to
    `cancelled`; a missing id errors cleanly (exit 1), never
    crashes.
  - `resolveObjectivesFile` is now exported from
    `@muse/autoconfigure`'s public surface (it existed since goal
    396 but only internally).
- Registered in `program.ts` alongside `muse tasks`.

## Verify

- `@muse/cli` commands-objectives.test.ts 4/4: add → list →
  cancel → list reflects through the REAL store
  (`MUSE_OBJECTIVES_FILE` override); default `--status active`
  hides a cancelled objective, `--status all` shows it; unknown
  `--kind` → closest-match hint + exit 1; cancel of a missing id →
  clean exit 1; user-scoping (a different `--user` sees a
  different bucket).
- `pnpm check` green across all workspaces (apps/cli 691, all
  packages) — this is a cross-package change (autoconfigure export
  → mcp store → cli), so the in-dependency-order workspace build
  is the correct gate; `pnpm lint` 0/0; `pnpm guard:core` clean;
  tsc strict clean.
- No request/response (LLM) path touched — local store I/O +
  commander wiring; no smoke:live applies.

## Status

Done. A user can now actually drive the delegated-autonomy chain:
`muse objectives add "watch the deploy until green"` registers it
into the same store the running daemon ticks, so the evaluator
re-evaluates it and acts/escalates per P9 — the substrate is
finally reachable end-to-end from the user's terminal. One
CAPABILITIES line appended citing P5-b1 (the bullet whose
user-facing surface this completes). No OUTWARD-TARGETS flip —
P5-b1 was already `[x]` on its durability-integration check; this
adds the genuine user surface that check did not strictly require.

## Decisions

- A verification failure was hit and root-caused, not skipped: the
  first single-package test run failed (empty output) + tsc
  TS2305 because `apps/cli` imports the BUILT `@muse/autoconfigure`
  and only source had the new `resolveObjectivesFile` export. The
  fix was the correct cross-package `pnpm check` (builds in
  dependency order) — never a skip/weaken. Post-build: 4/4, tsc
  clean, full check green.
- Local-mode only by design: the bullet's user need is "register
  / list / cancel a standing objective"; the local store path
  delivers that end-to-end (the daemon reads the same file).
  Remote/API + `--json` are thin follow-ups, deliberately not
  bundled (tight scope), mirroring how `muse tasks` started.
- CAPABILITIES line, no bullet flip: this is a genuine NEW
  user-exercisable surface (`muse objectives`) so it earns a
  CAPABILITIES line citing P5-b1, but nothing in OUTWARD-TARGETS
  was unmet to flip — recorded honestly, not as a false metric
  claim.
