# 242 — `muse persona` silently mislabeled a dangling active id

## Why

The persona preamble is prepended to **every** model-bound turn
(ask / brief / today / proactive). `resolveActivePersonaPreamble`
correctly fails soft: an `activeId` that is neither a built-in nor
an own `custom` key (a hand-edited `persona.json` that removed the
active custom, or a typo) resolves to `""` — the agent keeps
working with no preamble. That silent-safe runtime behavior is
right and is left untouched.

The problem was the **CLI diagnostic**, the only surface a user
has to notice and fix the misconfiguration:

- `muse persona show` printed, for any empty preamble,
  `(no preamble — the default persona delegates to the user's
  persona memory)`. With `activeId: ghost` that is actively
  wrong — it claims "the default persona" when the active id is
  `ghost`, hiding that the persona is broken.
- `muse persona list` printed `active: ghost`, no `*` marker on
  any row (ghost isn't listed), and **no** hint that the active
  id is dangling. The user sees a plausible-looking listing and
  never learns their persona silently does nothing.

So a typo or stale `activeId` makes Muse run with no persona
indefinitely while every status surface says everything is fine.

## Scope

- `apps/cli/src/persona-store.ts`: new exported predicate
  `personaIdIsKnown(store, id)` =
  `isBuiltinPersonaId(id) || Object.hasOwn(store.custom, id)`
  (`Object.hasOwn` so `__proto__`/`toString` are not "known").
  Mirrors `isBuiltinPersonaId`; pure + directly unit-tested.
- `apps/cli/src/commands-persona.ts`:
  - `show`: when the preamble is empty, branch on
    `personaIdIsKnown`. Known (e.g. the real `default`) → an
    accurate message naming the actual active id. Unknown →
    a stderr line stating the active id is unknown and resolves
    to no preamble, pointing at `muse persona list`. The old
    hard-coded "the default persona" wording is gone.
  - `list`: after the listing, if the active id is unknown, emit
    a one-line stderr note telling the user to `muse persona use
    <id>`. The `--json` paths are unchanged (the structured
    payload already exposes `activeId` + `personas`, so a
    machine consumer can detect the mismatch itself).

Runtime resolution (`resolveActivePersonaPreamble` /
`loadActivePersonaPreamble`) is deliberately unchanged — the fix
is purely the human-facing diagnostic.

## Verify

- `pnpm --filter @muse/cli test` — 555 pass (was 554). The
  existing persona-store unit test now also pins
  `personaIdIsKnown` (built-in incl. the empty `default`, own
  custom → true; dangling id + `__proto__` → false). A new
  command test drives `muse persona show` / `list` against a
  `persona.json` whose `activeId` points at a removed custom and
  asserts the "unknown" diagnostic appears, the misleading "the
  default persona delegates" line is gone, and a valid active id
  emits no false note.
- `pnpm check` — every workspace green (apps/cli 555, apps/api
  153, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (CLI persona admin
  diagnostic only; runtime preamble resolution unchanged), so no
  Qwen round-trip applies.

## Status

done — a dangling / typo'd active persona is now surfaced by both
`muse persona show` and `muse persona list` instead of being
mislabeled as "the default persona", so the user can actually
discover and fix a silently-disabled persona that otherwise
affects every reply.
