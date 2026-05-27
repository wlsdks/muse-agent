# 758 — P19 target-completion audit (the P→P seam check)

## Why

P19's bullet is `[x]` (753 weather retry) and no `P19 audit —` line
existed. Per the iteration-loop contract Step 4, this iteration's sole
mandate is to re-run the P19 CAPABILITIES check AND exercise P19 as
one end-to-end flow — does the hardening actually help the user, not
just pass in isolation?

P19 is a single-bullet target, so the seam to prove is hardening-vs-
the-real-consumer: does the weather retry COMPOSE with
`resolveWeatherLine` (the proactive-briefing path), so a transient
blip stops silently dropping the briefing's weather line?

## Verify

- New seam: `@muse/mcp` p19-seam.test.ts 2/2 —
  - `resolveWeatherLine` returns a real line through a transient 503
    on geocoding (retry recovers; the briefing keeps its weather).
  - WITHOUT retry (`retries: 0`) the same 503 → `undefined` (the
    briefing would drop weather) — so the retry is LOAD-BEARING, not
    cosmetic. This is exactly the gap 753 closed.
- Piece-check re-run green TOGETHER: p19-seam + weather-retry 10/10.
- `pnpm check` EXIT 0 (mcp 690, every workspace green); `pnpm lint`
  0/0. Test-only audit, no source change; contract-faithful fake
  fetch, no `smoke:live`.

## Status

PASS. The weather hardening composes with its real consumer: a
transient upstream blip no longer empties the proactive briefing's
weather line. No drift; no bullet reopened. Recorded `P19 audit — …
— PASS` in the README Rejected ledger. P19's bullet is "one
actuator"; hardening the remaining actuators (email / contacts /
smart-home) is follow-on outward work, not reopened scope.
