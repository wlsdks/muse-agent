# 502 — `MUSE_RATE_LIMIT_CHAT_PER_MINUTE` strict-parses the capacity (goal-414/444/463/469/470/489 sibling, security path)

## Why

`buildDefaultChatRateLimiter` (`apps/api/src/server-routes.ts:94`)
constructs the rate limiter for `/api/chat` — the security
gate that bounds how often a user / token can fire chat
requests. The capacity (per-minute token cap) was read with
lenient `Number.parseInt`:

```ts
const rawCapacity = Number.parseInt(process.env.MUSE_RATE_LIMIT_CHAT_PER_MINUTE ?? "", 10);
const capacity = Number.isFinite(rawCapacity) && rawCapacity > 0 ? rawCapacity : 60;
```

`Number.parseInt` reads leading digits and discards the rest.
A typo like `MUSE_RATE_LIMIT_CHAT_PER_MINUTE=60x` or unit-slip
`30s` silently became 60 / 30 — installing a capacity the
operator never asked for. Worse: a `1000m` typo (intending
"1000 per minute") gives 1000 silently; a `5e3` (intending
5000) gives 5. Same lenient-parse defect class as goals
414/444/463/469/470/489, here on a **security-relevant rate
limiter** where the wrong capacity widens (or narrows) the
abuse window.

`buildDefaultChatRateLimiter` was internal (not exported), so
the parse was untested.

## Slice

- `apps/api/src/server-routes.ts` — extracted the
  capacity-parsing logic into an exported pure helper
  `parseChatRateLimitCapacity(raw, fallback=60)` using the
  established strict-parse semantics (trim → `/^[+-]?\d+$/` →
  `Number.isInteger && > 0`). Same shape as goals 463 / 469 /
  470 / 489. `buildDefaultChatRateLimiter` now calls it.
  Behaviour byte-identical for every clean positive integer
  (`"60"` → 60, `"  120  "` → 120); only the lenient-prefix
  path is closed.
- `apps/api/test/parse-chat-rate-limit-capacity.test.ts` —
  new file, first direct test: fallback when undefined,
  clean-integer accepted (trimmed), 12 typo/unit-slip/
  decimal/scientific/negative/zero/empty cases all
  fall-through, custom fallback honoured.

## Verify

- New test 4/4 green; full `@muse/api` suite green (216
  passed, +4, 0 failed); tsc strict (api) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  helper to the prior lenient
  `Number.parseInt(raw ?? "", 10)` + `isFinite && > 0`
  makes the typo test fail with the precise pre-fix symptom
  (`"30s" must fall through to fallback: expected 30 to be
  60` — the silently-accepted unit-slip) while the
  clean-integer / undefined / custom-fallback tests stay
  green; fix restored, suite back to 4 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure parser — no LLM / model request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A typo'd / unit-slipped `MUSE_RATE_LIMIT_CHAT_PER_MINUTE`
no longer silently installs a rate limit the operator didn't
configure. Every clean integer value behaves identically. The
goal-414/444/463/469/470/489 strict-parse standard now covers
the chat rate limiter — the highest-leverage instance of the
class on the API security gate.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a security-path lenient-parse
sibling-asymmetry `fix:`, recorded honestly with this backlog
row — not a false metric.

## Decisions

- Step-8 redirect from the surrogate-cap run (499/500/501) to
  the strict-parse class on a fresh consumer — distinct
  defect class, distinct surface (API rate limiter).
- Mirrored goals 463 / 469 / 470 / 489's strict-parse
  semantics byte-for-byte (trim → regex → `Number.isInteger`):
  the cross-package strict-parse standard must read
  identically; a near-variant after five consistent fixes
  would be drift the convention exists to prevent.
- Extracted an exported pure helper rather than testing
  `buildDefaultChatRateLimiter` end-to-end: the parse logic
  is the only thing the iteration touches; an end-to-end
  test would couple to env / Fastify / ChatRateLimiter
  internals that aren't the contract being pinned. Smaller
  test surface, equally direct coverage of the actual
  defect.
