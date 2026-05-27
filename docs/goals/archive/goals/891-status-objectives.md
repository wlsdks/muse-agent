# Goal 891 — `muse status` surfaces standing objectives (incl. the escalated needs-you signal)

## Outward change

The `muse status` dashboard ("is JARVIS watching me?") now includes
a **objectives** section: how many standing objectives are active /
escalated / done / cancelled, and — when one has escalated — the
spec of the first escalated objective as a `⚠ needs you:` line.
Before, the dashboard read tasks, followups, and reminders but had
**zero** objective awareness, so the delegated-autonomy items
(`watch X until Z`, `tell me when W`) — and crucially an *escalated*
objective demanding the user's attention — were invisible in the
at-a-glance view.

## Why this, now

An exhaustive-list seam (same class as 890 scheduler-next / 878
export): the dashboard whose whole purpose is "what is JARVIS doing
for you" enumerated every personal store except objectives — the one
that most directly represents autonomous work on the user's behalf.
An escalated objective is the highest-value thing to surface (it's
blocked and needs the user) and it had no dashboard presence at all.

## How

`collectStatus` reads `~/.muse/objectives.json`
(`readObjectives` + a `defaultObjectivesFile` env helper, fail-soft
to `[]`) and a new local `summariseObjectivesRows(rows, userId)`
buckets by status (user-scoped, like followups/reminders),
surfacing the first escalated objective's spec as `escalatedSample`.
The summary lands on the snapshot as `objectives` (additive — no
`MUSE_STATUS_SCHEMA_VERSION` bump); `renderStatus` prints the counts
and the `⚠ needs you:` line.

## Verification

`apps/cli` `program.test.ts`: a new integration test seeds a temp
`MUSE_OBJECTIVES_FILE` with active / escalated / done / cancelled
objectives plus a different-user one, runs `muse status --user stark
--json`, and asserts the counts `{active:1, escalated:1, done:1,
cancelled:1, total:4}` (the other user's objective dropped) and
`escalatedSample` equals the escalated spec — exercising the real
`readObjectives` → `summariseObjectivesRows` path. Mutation-proven:
mis-bucketing escalated as active fails the test. The 2 full-suite
failures are the known voice-playback `/tmp` flake (src+dist of the
same test); `program.test.ts` passes 230/230 in isolation, `pnpm
lint` 0/0. No LLM path → no smoke:live (Ollama down regardless).

## Decisions

- Surfaced the escalated objective's spec specifically (not active's)
  — escalated is the only status that demands user action; the rest
  are counts.
- Kept the summariser local to `commands-status.ts` (CLI dashboard
  only); the `muse.status` loopback MCP tool builds its own snapshot
  and is a separate, parallel surface (out of scope for this slice).
