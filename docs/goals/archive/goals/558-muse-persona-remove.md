# 558 — `muse persona remove <id>` — symmetric CLI delete surface (goal-557 follow-up; closes the persona write-path grid)

## Why

Direct goal-557 follow-up. Goal 557 shipped `muse persona add`
and explicitly deferred `remove` to the next iteration with
the rationale "needs its own edge-case story (what happens to
`activeId` when the removed id was active) and gets its own
iteration". This iteration is that story.

The persona subcommand grid was three-of-four after 557:

| Path | Subcommand |
| --- | --- |
| List | `muse persona list` |
| Activate | `muse persona use` |
| Read active | `muse persona show` |
| Create / update | `muse persona add` (goal 557) |
| **Delete** | **— missing —** |

A user who experimented with a `tony` persona but wants to
clean it up has no CLI surface. Hand-editing
`~/.muse/persona.json` is the same hand-edit-power-user
escape valve that 557 closed, just for the delete path.

## Slice

- `apps/cli/src/commands-persona.ts` — registered the new
  subcommand:
  ```bash
  muse persona remove <id>
  ```
  Behaviour:
  - Empty / whitespace-only id → stderr + exit 1.
  - Built-in id (`default` / `jarvis` / `casual` /
    `professional`) → reject with stderr message
    `'jarvis' is a built-in — built-ins cannot be removed`
    + exit 1. The built-ins are baked into the binary; the
    custom slot can override them but the override is
    removed by deleting the same custom id.
  - Missing custom id → reject with stderr + did-you-mean
    hint reaching for the closest existing custom id
    (matches the goal-100 / goal-545 closest-command
    convention).
  - Happy path: rebuild `custom` minus the removed key.
    **When the removed id was the active persona, reset
    `activeId` to `"default"`** so `muse persona show`
    doesn't keep pointing at a deleted id (would
    silently resolve to `""` per
    `resolveActivePersonaPreamble`). Echo
    `(active persona reset to default)` so the user has
    an audit signal.
  - Removing an inactive custom leaves `activeId`
    untouched — the active-reset message is omitted.
- `apps/cli/test/program.test.ts` — added one integration
  `it(...)` covering: active-removal (active resets to
  `"default"`, siblings survive, audit message present),
  inactive-removal (no audit message, activeId stays),
  built-in collision rejection (`jarvis` → exit 1, no
  store mutation), missing-id rejection with did-you-mean
  hint (`tonu` → suggests `tony`).

## Verify

- New `it(...)` green; full `@muse/cli` suite green (1000
  passed, +1 vs baseline 999, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): replacing the
  `wasActive ? "default" : store.activeId` reset logic
  with a bare `{ ...store, custom: nextCustom }` write
  (preserves the now-dangling `activeId`) makes the
  active-reset assertion fail with the precise pre-fix
  symptom — `removing the active custom must reset
  activeId so muse persona show doesn't keep pointing at a
  deleted id: expected 'Removed custom persona tony\n' to
  contain '(active persona reset to default)'`. Fix
  restored, suite back to all green (1000 passed).
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 1000 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the four intended files.
- Pure CLI write surface — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is `muse
  persona remove` and the resulting `~/.muse/persona.json`
  layout, not the model loop.

## Status

Done. The persona subcommand write-path grid is now
complete:

| Path | Subcommand |
| --- | --- |
| List | `muse persona list` |
| Activate | `muse persona use` |
| Read active | `muse persona show` |
| Create / update | `muse persona add` (557) |
| **Delete** | **`muse persona remove` (this goal)** |

No CAPABILITIES line / no OUTWARD-TARGETS flip: all
P-bullets are already `[x]` and audited; a CLI write-surface
`feat:` completing the persona create/read/update/delete
grid, recorded honestly with this backlog row — not a
false metric.

## Decisions

- Active-id reset to `"default"` on removal of the active
  persona. Considered alternatives: (a) reject the
  removal with "deactivate first via `muse persona use
  default`" — too noisy for a routine cleanup; (b) leave
  the dangling activeId and rely on `personaIdIsKnown`'s
  silent fallthrough — already proven brittle by the
  goal-242 "dangling active id" fix that surfaced exactly
  this defect-class. Auto-reset to `default` is the
  least-surprising behavior; the audit message keeps the
  user informed.
- Did-you-mean reaches into ONLY `Object.keys(store.
  custom)` (not the built-in list). The built-ins are not
  removable, so suggesting one would just produce a
  follow-up rejection. Matches the spirit of the
  goal-545 / goal-543 convention: the suggestion set
  matches the actionable candidate set.
- Built-in collision rejected with a distinct message
  ("built-ins cannot be removed", not "pick a different
  id" like `add`). The two errors are semantically
  different: `add` can't shadow a built-in (would be a
  typo); `remove` can't delete a built-in (would corrupt
  the baseline). Distinct messages so the user knows
  WHY without grepping for the command.
- The custom rebuild uses `Object.create`-free `{ }`
  literal (line 95-97 idiom): the `readPersonaStore`
  reader is the security gate; once the data is in
  memory, ordinary object literals are fine. The
  null-prototype guard at READ time protects against
  hand-edited `__proto__` keys; the WRITE path never
  reintroduces them because the keys we copy back come
  from the already-filtered store.
- Tests cover both branches of the active-id reset:
  removing the active custom triggers the audit message,
  removing an inactive custom does not. The negative
  assertion (`not.toContain("active persona reset")`)
  pins the asymmetry so a future regression can't
  silently turn the audit message on for inactive
  removals.
- Mutation reverts the active-reset logic specifically.
  The other branches (built-in collision, missing-id
  did-you-mean, store rebuild) follow the established
  conventions from goals 100/242/543/545/557; the
  active-reset branch is THIS iteration's net-new
  behaviour and the right mutation target.
