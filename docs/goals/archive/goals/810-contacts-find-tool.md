# 810 — feat: `find_contact` agent tool (look up a person)

## Why

The agent could SEND email to a contact (`email_send` resolves the
recipient internally) but couldn't ANSWER "what's Jane's email? / who
is Bob?" — there was no contacts read tool. People are a core
daily-driver perception; this exposes the contacts graph as a
read-only lookup, reusing `resolveContact`'s fail-close semantics.

## Slice

- `@muse/mcp` contacts-tool.ts — `createContactsFindTool({ contacts })`
  exposes a `risk: "read"` tool `find_contact` (param `name`,
  described) over `resolveContact`: a resolved name → `{ found,
  name, email?, handle? }`; an AMBIGUOUS name → `{ found:false,
  ambiguous:true, candidates:[names] }` (never a guessed person —
  outbound-safety recipient resolution); unknown / empty → `found:false`.
- `@muse/autoconfigure` index.ts — registered unconditionally (local
  contacts store, no creds) over `queryContacts(resolveContactsFile)`.

## Verify

- `@muse/mcp` contacts-tool.test.ts (new, 3): `risk:read` + resolves an
  exact name to email/handle; an ambiguous name returns the candidate
  names (not a guess); unknown / empty name → `found:false`.
- `@muse/autoconfigure` contacts-find-wiring.test.ts (new, 1): the REAL
  `createMuseRuntimeAssembly` exposes `find_contact` (risk:read).
- **Mutation-proven**: dropping the ambiguous branch → the
  candidates test fails; restore → 3/3. Full `pnpm check` EXIT 0,
  `pnpm lint` 0/0. Tool catalog rides the model request → live
  SELECTION wants `smoke:live`; Ollama down → deferred.

## Decisions

- **Fail-close lookup, never a guess** — reuses `resolveContact`, so an
  ambiguous "Bobby" returns candidates for the agent to clarify rather
  than picking one (the recipient-resolution backbone). Read-only, no
  approval gate.
- Completes the agent-reachable personal-perception set: home (806) /
  weather (807) / email (808) / contacts (810). No bullet flip —
  perception EXPAND, CAPABILITIES line under P20.
