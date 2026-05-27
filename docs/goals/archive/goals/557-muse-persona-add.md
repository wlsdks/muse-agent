# 557 — `muse persona add <id> <preamble...>` — CLI create-custom-persona surface (closes the missing pair with `use` / `list` / `show`)

## Why

Step-8 redirect away from the run of comparator-determinism
fixes (551-556). Different defect class: a missing CLI surface
on an existing feature.

The `muse persona` command group ships built-in personas
(`default` / `jarvis` / `casual` / `professional`) plus a
custom-persona override slot in `~/.muse/persona.json`. The
existing subcommands cover the read + activate paths:

- `muse persona list` — list builtins + customs + active id
- `muse persona use <id>` — flip active to a known id
- `muse persona show` — print the active preamble

But the write path is missing. A user who wants a `tony`
persona (sardonic, confident) or a `formal-jarvis` variant of
the built-in JARVIS has to:

1. Stop the CLI.
2. Hand-edit `~/.muse/persona.json` (a JSON file with a
   null-prototype-guarded `custom` map).
3. Re-launch.

That's the wrong UX for a JARVIS-style assistant whose
identity is supposed to be one command away. The natural
companion to `use` is `add` — register the custom persona
through the CLI, then `use` it.

## Slice

- `apps/cli/src/commands-persona.ts` — registered the new
  subcommand:
  ```bash
  muse persona add <id> <preamble...>
  ```
  - `<id>` trimmed; empty / whitespace-only rejected with
    a `<id> must not be empty` stderr line + exit 1.
  - Built-in id collision rejected with an actionable hint
    (`'jarvis' is a built-in id — pick a different id
    (e.g. 'jarvis-mine')`) + exit 1. Why reject vs allow:
    the `custom` map can override a built-in (read code at
    `persona-store.ts:139` does that intentionally for the
    hand-edit path), but doing it through `add` is almost
    always a typo — the user types `jarvis` meaning "add a
    new jarvis-flavored persona" and silently shadows the
    built-in. Failing loudly with a suggested rename
    prevents the silent-shadow class of bug.
  - Preamble joined from the variadic `<preamble...>`
    argument and trimmed; empty result rejected with a
    `<preamble> must not be empty` stderr line + exit 1.
  - Happy path writes through `writePersonaStore` (same
    null-prototype-safe writer used by `use`) and echoes
    `Added custom persona <id>\n`.
  - Replacing an existing custom id (re-adding the same
    name with a new preamble) is allowed and echoed as
    `Updated custom persona <id>\n` so the user knows
    they're overwriting, not creating.
- `apps/cli/test/program.test.ts` — added one integration
  `it(...)` covering: happy-path add (round-trips through
  `readPersonaStore`), update of an existing custom id,
  built-in collision rejection (`jarvis` → exit 1 with
  hint + the store is NOT mutated), whitespace-only
  preamble rejection (`blanky` → exit 1 with hint + the
  store is NOT mutated).

## Verify

- New `it(...)` green; full `@muse/cli` suite green (999
  passed, +1 vs baseline 998, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): deleting the
  `isBuiltinPersonaId(trimmedId)` guard makes the new test
  fail with the precise pre-fix symptom — `expected
  collideText to contain "'jarvis' is a built-in id"`
  followed by the store-not-mutated assertion. Fix
  restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 999 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the four intended files.
- Pure CLI write surface — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is `muse
  persona add` and the resulting `~/.muse/persona.json`
  layout, not the model loop.

## Status

Done. The persona subcommand grid is now complete:

| Path | Subcommand |
| --- | --- |
| List | `muse persona list` |
| Activate | `muse persona use` |
| Read active | `muse persona show` |
| **Create / update** | **`muse persona add` (this goal)** |
| Delete | (deferred to a fresh iteration) |

A natural fresh-iteration follow-up is `muse persona remove
<id>` — the symmetric delete surface (reject built-ins,
reset `activeId` to `default` if the removed custom was
active). Not in scope for this iteration.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all
P-bullets are already `[x]` and audited; a CLI write-surface
`feat:` on an existing P0 / context-engineering feature
(personas), recorded honestly with this backlog row — not a
false metric.

## Decisions

- Step-8 redirect from the recent comparator-determinism
  cluster (551-556) onto a fresh defect class: missing CLI
  surface on an existing feature.
- Built-in id collision is rejected (not silently
  overridden). Reason: the file-level override is for
  hand-edit power users; the CLI surface should be loud
  about a likely typo. The rename hint
  (`'jarvis-mine'`) is the suggested escape valve. This
  matches the existing `muse persona use <toString>`
  rejection pattern (CLI never silently accepts a
  semantically-suspect id; the hand-edit power path is
  separate).
- Re-adding an existing custom id is allowed (echoed as
  `Updated`, not `Added`). Reason: simplicity. A
  separate `update` command would duplicate every
  argument. The differentiated stdout message gives the
  user the audit signal they need.
- Did NOT add `muse persona remove` in this iteration.
  Reason: tight scope; one capability per commit keeps
  the diff reviewable. The remove command needs its own
  edge-case story (what happens to `activeId` when the
  removed id was active) and gets its own iteration.
- The variadic `<preamble...>` argument follows the
  existing `muse objectives add <spec...>` shape so the
  user can type multi-word preambles without quotes.
  Cross-command convention.
- Preamble validation: `.join(" ").trim()` rejecting empty
  after trim. Same shape goals 538/532 used for "blank
  after trim must be rejected, not silently substituted
  with the default" — the trim-symmetry convention now
  reaches a fresh surface.
