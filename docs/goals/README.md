# Goals

The self-driving backlog for the autonomous iteration loop.

The loop **never stops, never asks a human for work, never
completes**. It fires every ~20 min, ships one commit, repeats
forever. The loop sets its own outward direction.

Read these every iteration, in order:

1. **[`.claude/rules/iteration-loop.md`](../../.claude/rules/iteration-loop.md)**
   — the authoritative contract (5 rules up top).
2. **[`OUTWARD-TARGETS.md`](OUTWARD-TARGETS.md)** — the loop's
   self-directed north star + target map (loop owns/evolves the
   *direction*; honesty machinery is immutable).
3. **[`CAPABILITIES.md`](CAPABILITIES.md)** — the only success
   metric (append-only; every goal adds one green automated check).
4. `MEMORY.md`.

This file is just the backlog table + ledger. The definitions,
procedure, falsification rule, regression sweep, and immutable core
live in the contract — don't restate them here.

## Backlog (append/flip-only)

Add ≤1 row, flip status of goals you touched; never reorder, never
delete an open row, never rewrite another goal's status.

| #   | Goal                                                                    | Category       | Status           |
| --- | ----------------------------------------------------------------------- | -------------- | ---------------- |
| 373 | [Proactive multi-device routing](373-proactive-multi-device-routing.md) | epic / outward | done             |
| 374 | [`muse ask --notes-only`](374-muse-ask-notes-only.md)                   | outward        | done (pre-built) |
| 375 | [Web UI history panel](375-web-history-panel.md)                        | epic / outward | done             |
| 377 | [Inbound conversational replies](377-inbound-conversational-replies.md)  | epic / outward | done — P1 fully delivered (b1–b4) |
| 378 | [Knows-you from real use](378-knows-you-from-real-use.md)                | epic / outward | P0-b1+b2 done; P0-b3/b4 next |
| …   | *self-generated outward via discovery — never ends*                     |                |                  |

Closed infra (not loop work): 376 progress dashboard + tunnel —
human-operated; see its md.

## Rejected ledger (so fresh agents don't re-mine)

Append one line when a discovery path is evaluated and deferred:
`- <area> — iter <hash> — deferred: <reason>`

- smoke:live picker model speed — iter a147d939 — deferred: owner's
  Ollama-only picker fix confirmed working (real `/api/chat`
  round-trips, HTTP 200, ~50-60s each); it prefers the largest
  local qwen (`qwen3.6:35b-a3b`) so a full 6-endpoint run exceeds a
  5-min wrapper. Future outward (Autonomy: faster loop
  self-verification): prefer a fast small qwen (e.g. `qwen3:8b`)
  for smoke:live, or shard endpoints. Not slice-3 scope.
- web Playwright e2e infra — iter (375 s3) — deferred: no
  playwright.config / e2e harness exists in `apps/web` (only the
  dev-dep). Standing up config + browser install + seeded-API
  harness is its own infra task; the right-sized verified check for
  375 s3 was the `App.test.tsx` MuseConsole render assertion. A
  future outward goal can build the e2e harness if a real failure
  motivates it.
- smoke:live local-Qwen nondeterminism — iter (377 s2) — observed,
  not a regression: smoke:live ran real round-trips (owner picker
  fix works) 10 pass / 3 fail. The 3 (chat strict tool-loop didn't
  emit `time_now`; native web_search 0 citations / "no web tool";
  notes.search picked a different note) are small-local-model
  behaviour on endpoints goal-377 does NOT touch (the inbound
  daemon is off without `MUSE_INBOUND_REPLY_ENABLED`); the agent
  path P1-b2 depends on PASSED live (`/api/chat — direct answer`,
  `plan_execute (live)`). A future Autonomy goal: make these three
  CAPABILITIES checks robust to local-model variance (prompt
  hardening / model-capability gating), or tag them
  `[UNVERIFIED-LIVE]`. Not 377-scope.
- P1 audit — apps/api/test/p1-seam.test.ts — PASS: P1's four
  CAPABILITIES checks pass together AND compose end-to-end —
  `startInboundReplyTick` → `respondToInbound` →
  `createThreadedInboundRunner` → channel approval gate → real
  `TelegramProvider` HTTP, with the turn-1 user+reply carried into
  the turn-2 agent run (thread continuity through the tick path)
  and a write/execute tool blocked with an in-chat approval prompt
  POSTed to the same chat. No drift; no bullet reopened. P1
  (two-way conversation on a real channel) is genuinely delivered
  for the user, not just per-piece.
- P0-b2 production embedder wiring — iter (378 s2) — deferred: the
  embedding-recall provider + cosine + paraphrase proof shipped;
  remaining child is wiring a zero-cost local-Ollama embedder into
  `createMuseRuntimeAssembly` so production episodic recall uses
  `EmbeddingEpisodicRecallProvider`. Next 378 slice — kept separate
  from the provider so neither half is half-shipped.
