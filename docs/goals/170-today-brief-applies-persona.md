# 170 — `muse today --brief` applies the active persona

## Why

Goal 158 made `muse chat` speak in the active persona's voice.
The flagship "morning briefing" surface (`muse today --brief`)
was missed — `renderBrief` builds its own request and applied
no persona on either path:

- Remote: `{ message, metadata }` to `/api/chat`, no
  `systemPrompt`.
- Local: `runLocalBrief` sent only `BRIEF_SYSTEM_PROMPT`.

So a user who picked the `jarvis` persona got a generic brief
instead of one in character — the most visible JARVIS surface
breaking persona consistency.

## Scope

- `commands-today.ts`:
  - `renderBrief` loads `loadActivePersonaPreamble()` once
    (empty default-persona → unchanged request, parallel to
    goal 158).
  - Remote path: adds `body.systemPrompt = preamble` when
    non-empty (server prepends it as a system message).
  - `runLocalBrief` takes the preamble and prepends it to
    `BRIEF_SYSTEM_PROMPT` as the system content.
- `program.test.ts`: new "today --brief applies the active
  persona as systemPrompt (goal 170)" — seeds a jarvis
  persona file, asserts the `/api/chat` body carries
  `systemPrompt` containing the JARVIS preamble. (The
  goal-158 `MUSE_PERSONA_FILE` isolation keeps the other
  today-brief exact-body tests deterministic.)

## Verify

- `pnpm --filter @muse/cli test` — 434 pass (1 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-food (Ollama qwen3:8b, reasoning off, persona=jarvis):
  `muse today --brief --local` →
  *"Sir, the most urgent task is… I recommend attending to the
  dental reminder first."* — JARVIS address + anticipatory
  next-step from the preamble, applied end-to-end. Previously
  generic.

## Status

done — persona consistency now spans `muse chat` (158) and
`muse today --brief` (170), the two primary conversational
surfaces. Real-LLM request path touched; verified via a live
qwen3:8b round-trip (smoke:live needs a provider key).
