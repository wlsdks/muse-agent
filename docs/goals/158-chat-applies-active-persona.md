# 158 — `muse chat` applies the active persona preamble

## Why

Dog-food finding: `muse persona use jarvis` then `muse chat
"..."` produced a *generic* reply — the persona was silently
ignored. Only the interactive REPL (`muse chat -i` /
`runChatRepl`) folded the persona in; the one-shot `muse chat`
path (both `--local` and remote) sent either zero system
content or just the now-context line.

`runLocalChat` even had a comment explicitly declining to load
persona, reasoning "the chat one-shot path doesn't have userId
plumbed". That objection only applies to the *full*
`buildMusePersona` (which folds in user-memory facts/prefs).
`loadActivePersonaPreamble` is keyed solely on the active
persona id in `~/.muse/persona.json` — it needs no userId, so
the template preamble (JARVIS / casual / professional / custom)
can be applied on the one-shot path safely.

## Scope

- `apps/cli/src/chat-repl.ts` (`runLocalChat`):
  - Load `loadActivePersonaPreamble()`; when non-empty, prepend
    it to the existing now-context line as the system message.
    Empty (`default` persona) keeps the prior now-only behaviour.
- `apps/cli/src/program.ts` (`chat` action):
  - Resolve the preamble once for the remote paths and pass it
    as `systemPrompt` to `apiRequest("/api/chat", …)` and
    `streamRemoteChat`. `dropUndefined` strips it for default
    users so the request shape is unchanged for them. Local path
    self-loads inside `runLocalChat` (it has other call sites).
- `apps/cli/src/program-helpers.ts` (`streamRemoteChat`):
  - New optional `systemPrompt` param threaded into the
    `/api/chat/stream` body (server already accepts `systemPrompt`
    — `parseMessages` prepends it as a system message).

## Test isolation fix

The exact-body chat assertions in `program.test.ts` read the
developer's real `~/.muse/persona.json`. A machine where
`muse persona use jarvis` was ever run would leak a
`systemPrompt` field and fail non-deterministically. Added a
`beforeEach`/`afterEach` in the `cli program` describe block
pinning `MUSE_PERSONA_FILE` to a nonexistent temp path →
deterministic empty (`default`) preamble for every test that
doesn't set its own. This closes a pre-existing home-dir
test-pollution gap, not just the new path.

## Verify

- `pnpm --filter @muse/cli test` — 411 pass (2 new persona-chat
  tests + 5 previously home-dir-flaky tests now isolated).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Real-LLM dog-food (Ollama `qwen3:8b`, reasoning off):
  - `persona use default` + chat → generic.
  - `persona use jarvis` + chat "한국어로 인사 한 문장" →
    **"안녕하세요, sir."** — the JARVIS preamble's "address the
    user as 'sir'" instruction is demonstrably applied.

## Status

done — the persona system is now consistent across REPL and
one-shot `muse chat` (local + remote + stream). `muse persona
use <id>` finally changes the one-shot chat voice.
