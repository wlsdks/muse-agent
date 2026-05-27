# Goal 893 — `muse open <id>` scans the objectives store

## Outward change

`muse open <id-prefix>` — the unified "inspect any record by its ID
prefix" lookup — now scans the standing-objectives store. Before, its
probe order was `reminders → followups → episodes → patterns-fired →
proactive-history → tasks`, so `muse open obj_a1b2` returned "no
records found" even though objective IDs are real and surfaced by
`muse status` (891), `muse.status` (892), and `muse objectives list`.
Now an `obj_<uuid>` prefix resolves to the full objective record.

## Why this, now

An exhaustive-list seam, same class as 878 (export) / 890
(scheduler-next) / 891-892 (status objectives): the command whose
docstring promises it "scans every known store" omitted objectives.
With objective IDs now visible across three other surfaces, a user
copying one into `muse open` hit a dead end. Smallest verifiable
correctness fix that completes the unified-lookup contract.

## How

`scanAll` gains an objectives probe (`readObjectives` over
`MUSE_OBJECTIVES_FILE`, fail-soft `[]`, prefix-match on `id`) inserted
after followups; `Hit.kind` gains `"objective"`; the docstring probe
order is updated. The disambiguation / `--json` / `--raw` paths need
no change — a hit of `kind: "objective"` flows through them like any
other.

## Verification

`apps/cli` `commands-open.test.ts` (new): seeds a temp
`MUSE_OBJECTIVES_FILE` with an `obj_…` objective (other stores pointed
at absent files → empty), runs `muse open obj_abcdef --json`, and
asserts the envelope is `{ kind: "objective", record: { id, spec } }`
with the right id + spec — driving the real `readObjectives` scan.
Mutation-proven: removing the objectives probe block fails the test.
The 2 full-suite failures are the known voice-playback `/tmp` flake
(src+dist of the same test); the new test passes in isolation, mcp
tests pass under the proper `pnpm` gate, `pnpm lint` 0/0. No LLM path
→ no smoke:live (Ollama down regardless).

## Decisions

- Probe order places objectives right after followups (both
  user-scoped delegated-intent stores) and before the
  fired/historical stores — cosmetic only, since IDs are unique
  across stores and ambiguity is surfaced regardless.

## Note (not a defect)

While falsifying, an earlier tick's `npx vitest run --root packages/mcp`
showed `DefaultMcpTransportConnector` "Connection closed" failures.
Root-caused this tick: the spawned `node -e` MCP-SDK child inherits
the **repo-root cwd** under `--root`, where the workspace SDK dep
isn't resolvable. Under the real gate (`pnpm --filter @muse/mcp test`,
cwd = package) all 930 mcp tests pass. So it is a falsification-command
artifact, NOT a product or test defect — the connector already
supports `config.cwd`. Future mcp falsification should use
`pnpm --filter` or `cd packages/mcp` for child-spawning tests.
