# 026 — Followup dedupe — same-summary same-minute

## Why

The followup-capture hook already de-dupes by minute-precision
scheduledFor (followup-capture-hook.ts:144). But if the LLM repeats
the same promise across two adjacent turns with a slightly different
phrasing ("I'll ping you in 30" vs "I'll follow up in 30 minutes"),
both land. Add a content-similarity check too.

## Scope

- Hash the lowercased + sanitized summary's first N words.
- If a recent (same userId, same minute) entry shares the hash,
  skip the new one.
- Tests: prove both shapes (same scheduledFor minute, similar
  summary) collapse to one entry.

## Verify

- pnpm check / lint / smoke.
- agent-core +1 test.

## Status

deferred
 — needs a new content-similarity hash in the capture hook +
sidecar of recent hashes per minute. Deferred until a real
dogfood collision is observed (the existing minute+userId
dedupe has covered every case so far).
