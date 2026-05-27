# 822 — feat: `remove_contact` agent tool (fail-close delete by name)

## Why

The agent could find (810) and add (816) contacts but not remove one —
"forget that contact" / undo a wrong `add_contact` was impossible in
conversation. Completes the contacts CRUD for the agent. Removal is the
highest-stakes contacts write, so it is fail-close: an ambiguous name
returns the candidates and removes NOTHING (never deletes a guessed
person).

## Slice

- `@muse/mcp` contacts-tool.ts — `createContactsRemoveTool({ contacts,
  remove })` exposes a `risk: "write"` tool `remove_contact` (param
  `name`): resolves via `resolveContact`; a resolved name → `remove(id)`
  → `{ removed }`; AMBIGUOUS → `{ removed:false, ambiguous:true,
  candidates }` (no removal); unknown / empty → `removed:false`.
- `@muse/autoconfigure` index.ts — registered over `removeContact(
  resolveContactsFile(env), id)` (local store, no creds).

## Verify

- `@muse/mcp` contacts-tool.test.ts (+3): `risk:write` + removes an
  exactly-resolved contact by id (capturing `remove`); an ambiguous
  name returns candidates and removes NOTHING; unknown / empty removes
  nothing.
- `@muse/autoconfigure` contacts-find-wiring.test.ts (+1): the REAL
  assembly exposes `remove_contact` (risk:write).
- **Mutation-proven**: dropping the ambiguous early-return → an
  ambiguous name no longer surfaces candidates → the test fails;
  restore → 9/9. Full `pnpm check` EXIT 0, `pnpm lint` 0/0. Tool
  catalog rides the model request → live SELECTION wants `smoke:live`;
  Ollama down → deferred.

## Decisions

- **Fail-close removal** — reuses `resolveContact`, so "Bobby" (two
  matches) returns the candidates instead of deleting one; the agent
  must clarify. The recipient-resolution backbone applied to deletion.
- Completes the contacts CRUD agent triad (find / add / remove). No
  bullet flip — perception/people EXPAND. CAPABILITIES line under P20.
