# 816 — feat: `add_contact` agent tool (capture a person mid-conversation)

## Why

810 let the agent FIND a contact; the contacts store + `muse contacts
add` let the user add one — but the agent had no tool to CAPTURE a
person in conversation ("I just met Bob, save bob@x.com"). A local
personal-store write (same class as notes/tasks `add`), completing the
contacts read+write pair for the agent.

## Slice

- `@muse/mcp` contacts-tool.ts — `createContactsAddTool({ save,
  idFactory? })` exposes a `risk: "write"` tool `add_contact` (name
  required, at least one of email/handle, optional MM-DD/YYYY-MM-DD
  birthday) that builds a `Contact` and persists it via the injected
  `save`. Refuses an unnamed or unreachable (no email/handle) contact
  and a malformed birthday — never saves junk.
- `@muse/autoconfigure` index.ts — registered over `addContact(
  resolveContactsFile(env), …)` (local store, no creds).

## Verify

- `@muse/mcp` contacts-tool.test.ts (+3): `risk:write` + saves
  name/email/birthday through a capturing `save`; refuses empty name
  and email-and-handle-less contacts (nothing saved); rejects a
  malformed birthday.
- `@muse/autoconfigure` contacts-find-wiring.test.ts (+1): the REAL
  `createMuseRuntimeAssembly` exposes `add_contact` (risk:write).
- **Mutation-proven**: removing the "at least email/handle" guard → an
  unreachable contact saves → the refuse test fails; restore → 6/6.
  Full `pnpm check` EXIT 0, `pnpm lint` 0/0.
- Tool catalog rides the model request → live SELECTION wants
  `smoke:live`; Ollama down → deferred.

## Decisions

- **Local-store write, ungated** — same class as notes/tasks `add`
  (the runtime's write-risk exposure policy gates it, not an
  approval prompt); it sends nothing to anyone, so outbound-safety's
  draft-first does not apply. Reuses the contacts store's `addContact`
  (atomic, id-keyed → re-adding the same id replaces).
- Refuses unreachable contacts so the recipient-resolution backbone
  stays meaningful. No bullet flip — completes the contacts read+write
  agent pair. CAPABILITIES line under P20.
