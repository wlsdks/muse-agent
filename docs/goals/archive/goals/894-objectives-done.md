# Goal 894 — `muse objectives done <id>` marks a standing objective accomplished

## Outward change

`muse objectives done <id-or-prefix>` flips a standing objective to
status `done` (resolution "completed via CLI") — distinct from
`cancel`, which records `cancelled`. Before, the only manual terminal
transition was `cancel`, so a user who *accomplished* a delegated
objective ("watch the build until green" → it went green) had to
mark it `cancelled` — conflating "I achieved this" with "I gave up
on it" in the accountability log.

## Why this, now

`muse status` (891) and the `muse.status` tool (892) surface `done`
and `cancelled` as **distinct** counts, but only the objectives
daemon could ever set `done` — the CLI offered no way. So the `done`
count was unreachable by a user manually closing out an objective,
and the semantic distinction the dashboard advertises was unusable.
A CRUD-completeness gap exposed by the status work; the `done` verb
is the missing terminal transition.

## How

Extracted a shared `transitionObjective(id, command, target)` helper
(resolve exact-or-unambiguous-prefix via the 884 `resolveObjectiveId`
→ `patchObjective` with the target status + resolution → report) and
pointed both `cancel` and the new `done` at it. `cancel` is
behaviour-preserving (same messages); `done` sets `status: "done"`,
`okWord: "Marked done"`. `ObjectiveStatus`/`patchObjective` already
supported `done` (the daemon used it), so this only adds the user
entry point.

## Verification

`apps/cli` `commands-objectives.test.ts`: `done` on a fresh objective
prints `Marked done <id>` and the store records status `done` (NOT
`cancelled`) — asserted via `list --status all --json` and
`list --status done`; `done` also accepts a 12-char prefix and
reports a missing id cleanly (exit 1 + "no objective with id"). The
existing `cancel` suite stays green through the shared helper.
Mutation-proven: pointing `done`'s target at `cancelled` fails the
status-distinction test. The 2 full-suite failures are the known
voice-playback `/tmp` flake; `pnpm lint` 0/0. No LLM path → no
smoke:live (Ollama down regardless).

## Decisions

- A terminal `done` does not conflict with the daemon: the daemon
  re-evaluates `active` objectives; `done`/`cancelled`/`escalated`
  are terminal, so a manual `done` is respected, not re-flipped.
- Shared the resolve+patch helper rather than copy-pasting cancel's
  20-line block — the second terminal verb made the duplication
  worth collapsing (behaviour-preserving for cancel).
