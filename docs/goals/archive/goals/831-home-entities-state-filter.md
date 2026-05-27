## 831 — feat: "what's left on / unlocked?" — home_entities state filter

## Why

"Is anything left on?" / "what lights are on?" / "is the front door
unlocked?" is a daily home-check ask. `home_entities` could list all
entities (optionally by domain), but the local model then had to scan
the list and reason about which states count — exactly the multi-step
reasoning a small model does unreliably. A server-side state filter
makes it a one-shot answer.

## Slice — DEEPEN the existing tool, no new catalog entry

`@muse/mcp` smart-home-tool.ts — `home_entities` gained an optional
`state` filter (case-insensitive): with it, only entities whose current
state equals the value are returned. Combines with the existing
`domain` filter, so "what lights are on?" → `domain:"light",
state:"on"` and "is anything unlocked?" → `state:"unlocked"`. Omitting
`state` is the prior list-everything behaviour. Keeping it one tool (an
extra arg, not a new tool) protects one-shot selection per
tool-calling.md rule 5.

## Verify

`@muse/mcp` smart-home-entities.test.ts (+3, 8 total), contract-faithful
fake `/api/states` fetch:
- `state:"ON"` returns only the `on` light (case-insensitive match);
- `domain:"lock" + state:"unlocked"` → 0 when the only lock is locked
  (the "is it unlocked?" check);
- the schema declares `state`.
- **Mutation-proven**: dropping the `state` filter (return all) → both
  state-filter tests fail. The existing list/domain/retry/malformed
  tests still green (additive). Full `pnpm check` EXIT 0, `pnpm lint`
  0/0. The tool name/keywords are unchanged so its SELECTION is
  unaffected; only argument-filling is new (no new catalog entry) →
  live smoke:live not applicable (and Ollama down).

## Decisions

- **Filter in the tool over the already-fetched list**, not a new HA
  query param — Home Assistant's `/api/states` returns everything; a
  client-side equality filter is exact, zero extra round-trips, and
  reuses the retry-hardened `listHomeAssistantStates`.
- **One tool + optional arg** over a new `home_whats_on` tool — same
  rationale as 828's weather `when`: keep the catalog flat for the
  local model. CAPABILITIES line under P20 Perception (no bullet flip —
  deepens an existing capability).
