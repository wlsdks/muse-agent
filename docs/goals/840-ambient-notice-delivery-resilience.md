## 840 — fix: ambient notices survive a transient delivery failure (no loss, no duplicates)

## Why

The 839 web-watch fix exposed a defect CLASS in edge-triggered
proactive runners. `createAmbientNoticeRunner` (P20 continuous
perception) had the same shape, with a worse symptom: `sink.deliver`
was un-wrapped in the per-notice loop, and `lastMatchedIds =
matchedIds` advanced the dedupe memory unconditionally AFTER the loop.
So when delivery failed mid-batch:
- the throw propagated out of `tick()`, skipping every later notice AND
  never reaching the `lastMatchedIds` assignment, so
- on the NEXT tick the dedupe memory was still the OLD set → every
  notice that DID deliver this tick RE-FIRED (duplicate ambient pings),
  while the failed one was retried.

A transient messaging blip turned into duplicate "you're in the
standup" notices — exactly the spam the edge-dedupe exists to prevent.

## Slice

`@muse/mcp` ambient-notice-loop.ts — `createAmbientNoticeRunner.tick`:
- carry forward already-fired rules that are STILL matching (they stay
  deduped); a rule no longer matched is dropped (re-arms) — same as
  before;
- wrap `deliver` per-notice and add a rule to the new dedupe set ONLY
  after a successful send. A failed delivery leaves the rule OUT → it
  re-fires next tick (not lost); an already-sent sibling stays in → it
  never duplicates; other notices still go out.

## Verify

`@muse/mcp` ambient-notice-runner.test.ts (+2, 4 total):
- a transient delivery failure (sink throws once) → the edge is NOT
  consumed: tick 1 delivers 0 (threw), tick 2 re-fires + succeeds;
- with two matching rules where the first's delivery throws once: the
  second STILL fires this tick (loop not aborted), and next tick the
  first re-fires + succeeds while the second is NOT re-delivered (no
  duplicate).
- The existing edge/steady/re-arm + throwing-source tests stay green
  (working sink → unchanged behaviour).
- **Mutation-proven**: reverting to the original "deliver un-wrapped,
  `lastMatchedIds = matchedIds` regardless" fails BOTH new tests while
  steady-state passes. `@muse/mcp` 903/903, `pnpm check` EXIT 0, `pnpm
  lint` 0/0. Runner internals, no LLM path / no model tool → no
  smoke:live.

## Decisions

- **Dedupe memory = successfully-notified rules**, not merely-matched
  rules — advancing it on match (regardless of send) is what turned a
  transient failure into duplicates. Gating each rule's entry on its
  own delivery success makes the dedupe honest under partial failure.
- Mirrors 839 (web-watch) deliberately — the same correct shape for
  every edge-triggered proactive runner (one consumer only reads
  `delivered`, so the `firedRuleIds` semantics change is internal).
  CAPABILITIES line under P20 ambient-perception reliability hardening
  (no bullet flip).
