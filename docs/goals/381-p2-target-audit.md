# 381 — P2 target-completion audit (the P→P seam check)

## Why

Both P2 bullets (b1 proactive daemon delivers to a real channel
API; b2 anticipatory prep rides that path) are `[x]` and no
`P2 audit —` line existed. Per the iteration-loop contract Step 4,
the sole mandate of this iteration is to re-run every P2
CAPABILITIES check together AND exercise P2 as one end-to-end user
flow against the falsifiable test — does the whole thing actually
work for the user, not just each piece in isolation?

## Verify

- The two P2 piece-checks pass together: `@muse/api`
  proactive-notice-delivery.test.ts 2/2 (b1 bare-notice POST +
  real dedupe; b2 prepped-doc POST).
- New seam: `apps/api/test/p2-seam.test.ts` 1/1.
- `pnpm --filter @muse/api test` 171 pass; `pnpm check` green
  across all workspaces (apps/cli 681, all packages); `pnpm lint`
  0/0; `pnpm guard:core` clean.
- No source change — the audit adds only the seam test. No
  request/response (LLM) path touched (flat-notice path), so no
  smoke:live applies.

## Status

PASS. The two P2 checks are green together, and they compose:
`p2-seam.test.ts` drives the realistic multi-tick daemon with a
real `LocalDirNotesProvider` + `createNotesInvestigator` wired into
`runDueProactiveNotices` over a real `TelegramProvider` HTTP —

1. tick 1 POSTs the imminent-item announcement AND the
   anticipatorily-prepped "Related notes: …" doc to the real Bot
   API (b1 delivery + b2 prep composed), decoy note excluded;
2. ticks 2 & 3 (item still imminent, so the rendered body — which
   includes the investigate-appended text — is regenerated) produce
   ZERO re-POSTs: the real dedupe sidecar key is item-derived, not
   body-derived, so the composed flow does not re-spam the real
   channel.

This closes the seam the two isolated tests left open: P2-b1's
dedupe test had no investigator; P2-b2's prep test was single-tick.
The composed flow honours the P2 "not noisy" quality bar. No drift;
no bullet reopened.

P2 (proactive delivery proven on a real channel) is genuinely
delivered end-to-end. P0, P1, P2 are now all delivered + audited.
Next iteration resumes Step 5 selection on the highest unmet
OUTWARD-TARGETS bullet — the next frontier is P3 (ambient
perception loop).

## Decisions

- The audit's mandated "exercise the target end-to-end" is a real
  composition test (`p2-seam.test.ts`), mirroring the P0/P1 audits'
  `*-seam.test.ts`. It asserts the seam the two isolated tests do
  not: that anticipatory prep (b2) reaches the real channel via the
  delivery path (b1) AND that the real dedupe survives the
  body-changing investigator across repeated ticks — the
  non-spammy property a JARVIS-grade proactive surface must have.
- The cross-tick / body-derived-vs-item-derived dedupe check is the
  genuine new risk: a fake registry can fire-and-forget; only a
  real delivery path over a real sidecar can prove the daemon does
  not hammer the user's channel every tick.
- No CAPABILITIES line appended and no bullet flipped: per Step 4
  the audit verifies already-flipped bullets compose; its
  deliverable is the README ledger `P2 audit — … — PASS` line
  (and a REOPEN on drift, which did not occur).
