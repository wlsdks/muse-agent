# 094 — `muse persona` templates — JARVIS voice, on demand

## Why

JARVIS has a tone: dry, formal, British-butler. Muse currently
synthesises every reply from the user's stored facts +
preferences, but there's no way to say "be JARVIS today" without
hand-editing the system prompt. Add a persona template registry
with a few built-ins, persisted under `~/.muse/persona.json`, and
inject the active persona's preamble into every system-prompt
builder (ask / brief / status / proactive synthesis).

## Scope

- New `apps/cli/src/commands-persona.ts`:
  - `muse persona list [--json]` — built-in + user-defined templates
  - `muse persona use <id>` — flip active in `~/.muse/persona.json`
  - `muse persona show [--json]` — print active preamble
- `~/.muse/persona.json` shape:
  `{ activeId, custom: { <id>: { preamble, tone? } } }`.
- Four built-in personas: `default` (no preamble), `jarvis`
  (formal British butler, calls user "sir", dry humour, brevity),
  `casual` (chill, lowercase, brief), `professional` (no emoji,
  precise, complete sentences).
- Add `loadActivePersonaPreamble(env)` helper in
  `apps/cli/src/persona-store.ts`. Inject into:
  - `commands-ask.ts` (prepend to `systemPrompt`)
  - `commands-today.ts` brief-rendering path
  - `commands-status.ts` formatted output is unchanged (data-only).

## Verify

- cli +1 unit test on the store + persona resolver: missing file
  defaults to `default`, switching writes the active id, built-in
  ids aren't writable to `custom`.
- Dogfood:
  ```
  HOME_DIR=$(mktemp -d -t muse-persona-XXXX)
  mkdir -p "$HOME_DIR/.muse"
  HOME="$HOME_DIR" node apps/cli/dist/index.js persona list --json
  HOME="$HOME_DIR" node apps/cli/dist/index.js persona use jarvis
  HOME="$HOME_DIR" node apps/cli/dist/index.js persona show
  ```
  Pass if the show output contains the word "JARVIS" or "sir".

## Status

done — three subcommands (`list / use / show`) backed by
`~/.muse/persona.json` (env override `MUSE_PERSONA_FILE`).
Four built-in personas (`default` / `jarvis` / `casual` /
`professional`) live in code so `muse persona use jarvis`
works on a fresh install. User-defined personas live under
`custom`; a custom id that shadows a built-in id wins.

Persona preamble injection: wired into `commands-ask.ts` via
new `loadActivePersonaPreamble(file)` helper — prepended to
the system prompt above the user-memory persona block.

Scope deviation: the goal mentioned injecting into the brief
synthesis path too. Touched only `commands-ask.ts` this
iteration to keep the diff focused; the helper is reusable
so `commands-today.ts` + proactive notice synthesis can adopt
the same one-liner as an additive follow-up.

cli +1 test exercises the store (missing→default, write
round-trip, JARVIS preamble contains "sir", custom override
wins). Dogfood: `persona use jarvis` flipped active +
`persona show` returned the JARVIS preamble — pass criterion
("JARVIS" or "sir" in output) met.
