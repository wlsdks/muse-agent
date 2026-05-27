# 392 — Proactive situational briefing (P8-b1) — loop-authored target

## Why

P0–P7 are all delivered + audited. Per the OUTWARD-TARGETS
contract ("the loop extends this map itself when all are
delivered … using its own judgement and best-practice knowledge
of what a great personal AI assistant does"), this iteration
self-extends the map with **P8 — Proactive situational briefing**,
chosen by the loop's judgement (no human authored it).

The reasoning: P2 proved per-item proactive delivery + anticipatory
prep — but a JARVIS speaks the *situation*, not N disconnected
pings. The proactive loop fires one notice per imminent item and
never SYNTHESISES imminent calendar/task items + delegated-
objective status into one coherent heads-up ("next 2 hours — 3pm
review; objective Y needs you; still watching Z"). That is the
genuine next outward gap and it composes the P2 (imminent) + P5
(objective lifecycle) substrate that is now complete.

## Slices

- s1 (P8-b1, THIS): `packages/mcp/src/situational-briefing.ts` —
  `composeSituationalBriefing`, a **pure deterministic** composer.
  Duck-typed `BriefingImminent` (mirrors the proactive loop's
  private `ImminentItem` public fields — no coupling) +
  `StandingObjective`. Output: one sectioned message —
  soonest-first `Upcoming:`, escalated objectives under
  `Needs you:` with their resolution, active under
  `Still tracking:`; done/cancelled excluded; `undefined` when
  nothing is worth saying (silence is correct — a JARVIS does not
  narrate an empty schedule); NaN-date items dropped;
  whitespace-collapsed so a multiline title cannot break the
  layout. Verified by `situational-briefing.test.ts`.
- s2 (P8-b2, DONE): `situational-briefing-loop.ts` —
  `runDueSituationalBriefing` composes the P8-b1 composer + the P2
  `sendWithRetry` real-channel path + a minimal atomic last-fired
  sidecar: nothing-to-say ⇒ silent (no POST); else POST the one
  briefing over the messaging registry and stamp the sidecar; a
  second tick within `windowMs` is deduped; the window elapsing
  allows a fresh brief. Verified by
  `situational-briefing-loop.test.ts` against a real
  `TelegramProvider` with only the HTTP boundary faked.

## Verify

- `packages/mcp/src/situational-briefing.test.ts` 5/5 (run
  directly) and within `pnpm --filter @muse/mcp test` (455 pass,
  no regression); tsc strict clean (ran proactively).
- `pnpm check` green across all workspaces (apps/cli 683, all
  packages); `pnpm lint` 0/0; `pnpm guard:core` clean (P8 added
  outside IMMUTABLE-CORE).
- No request/response (LLM) path touched — pure data layer; the
  bullet's mandated check is the deterministic composition
  integration. No smoke:live applies.

## Status

P8-b1 done. The bullet's check ("seeded imminent item + active +
escalated objectives → one briefing naming all with correct
framing, soonest-first; empty → undefined (integration)") is
delivered: a single sectioned message orders upcoming items
soonest-first, flags escalated objectives as "Needs you" with
their resolution, lists active as "Still tracking", excludes
done/cancelled, returns `undefined` on empty/finished-only
context, drops NaN dates, and collapses whitespace. P8-b1 flipped
`[ ]`→`[x]`; one CAPABILITIES line appended; README backlog row
added.

P8-b2 done. The bullet's check ("seeded context → one briefing
POSTed to the real channel API; a second tick in-window does not
re-POST (integration)") is delivered: a real `TelegramProvider`
(only the HTTP boundary faked) receives exactly one Bot API POST
carrying the synthesised briefing (the imminent item AND the
objective in one message); a second in-window tick is deduped by
the real last-fired sidecar; an empty situation is silent; the
window elapsing allows a fresh brief. P8-b2 flipped `[ ]`→`[x]`;
one CAPABILITIES line appended; README backlog row flipped to
done.

**P8 fully delivered (b1 synthesise · b2 deliver-deduped).** With
P0–P8 all delivered, the next iteration is — per contract Step 4 —
the P8 target-completion audit.

## Decisions

- This flips P8-b1: P8's two bullets are independent (compose vs
  deliver), and P8-b1's own mandated check is exactly the
  deterministic composition integration — delivered green. The
  channel delivery + LLM-prose synthesis is P8-b2 (the proven
  mechanism → delivery decomposition, e.g. 382), not gold-plated
  in here.
- `composeSituationalBriefing` is pure and takes a duck-typed
  `BriefingImminent` rather than importing the proactive loop's
  private `ImminentItem` — same no-coupling discipline the rest of
  the codebase uses; the proactive daemon adapts its items at the
  call site in s2.
- Silence on empty context is a deliberate quality-bar decision
  (the P1/P2 "don't be noisy" bar): `undefined` ⇒ the caller fires
  nothing. A briefing that says "you have nothing on" is noise.
- `feat(mcp)`: a new user-world capability surface (the synthesised
  situational picture), consistent with the personal-store /
  proactive siblings.
- P8-b2 dedupe is window-based (a minimal `{lastFiredAt}` sidecar),
  not the per-item proactive-fired structure: "once per
  situation-window" is a single cadence gate, not per-item
  dedupe — a dedicated one-field sidecar is the right-sized fit,
  not a reuse of the heavier per-item store.
- The setInterval daemon that drives `runDueSituationalBriefing`
  (mirroring the proactive/reminder ticks in apps/api) is the
  natural follow-up; the bullet's check is the contract-faithful
  delivery integration, delivered here — daemon wiring is not
  gold-plated in.
