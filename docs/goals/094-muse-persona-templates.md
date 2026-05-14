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

open
