## 872 — feat: `world_time` agent tool — conversational world clock

## Why

871 gave the CLI `muse time`, but a JARVIS's primary surface is
conversation: "what time is it in Tokyo?" / "is it morning in London?"
should work mid-chat, not only at the terminal. The deterministic,
DST-correct timezone logic existed in apps/cli — unreachable by the
agent. This completes 871's reach to the model.

## Slice

- Relocated the timezone logic (`resolveTimezone`, `formatTimeInZone`,
  the alias table) from apps/cli to `@muse/mcp` world-time.ts — one
  source of truth shared by the CLI and the tool (no duplication). The
  CLI `timezone.ts` now re-exports from `@muse/mcp`; `muse time` is
  unchanged.
- `createWorldTimeTool` — a read-risk `world_time` MuseTool (domain
  "system", keywords time/timezone/clock/시간/몇시, required `place`,
  example-bearing schema, "use when / not when" description). Resolves
  the place and returns `{ place, zone, time }`; an unknown place / empty
  input returns an `error` (never a guessed time). Wired always-on in
  the autoconfigure tool registry (zero-config, like `weather`).

## Verify

- `@muse/mcp` world-time.test.ts: resolveTimezone (alias / IANA /
  unknown), formatTimeInZone (Tokyo 09:00 from UTC-midnight, London DST
  Jul/Jan), and the tool handler (returns zone+time for Tokyo, errors
  for Atlantis / empty).
- `@muse/autoconfigure` world-time-relevance.test.ts: the REAL tool
  through the REAL `DefaultToolFilter` surfaces for "what time in tokyo"
  and NOT for unrelated prompts (one-shot-selection exposure).
- apps/cli timezone.test.ts stays green (re-export).
- **Mutation-proven**: making the handler fall back to UTC instead of
  erroring on an unknown place fails the error test.
- `pnpm check` EXIT 0, `pnpm lint` 0/0.

## Decisions

- **Exposure verified; live SELECTION [UNVERIFIED-LIVE]** — the
  DefaultToolFilter relevance test proves `world_time` SURFACES for time
  prompts (the deliverable, Ollama-down-verifiable, like 849/850/851);
  whether the local Qwen then PICKS it needs a `smoke:live` round-trip
  (Ollama down this session).
- **Relocate, don't duplicate** — the alias table is one source of truth
  in `@muse/mcp`; the CLI re-exports it.
- No new dependency (pure `Intl`).
