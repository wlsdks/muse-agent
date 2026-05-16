# 223 — HMAC webhook-signature verify must fail closed on any malformed input

## Why

`verifyHmacSha256Hex` (@muse/shared) is the webhook
signature-verification **guard** — the thing a future
Telegram/Slack/Discord/Line webhook route uses to authenticate
inbound requests. The non-negotiable is "Guards are
fail-close." Its first line was:

```ts
const normalized = signature.startsWith("sha256=") ? … : signature;
```

`signature` is typed `string`, but an HTTP signature header is
routinely **absent** — a handler that forwards
`req.headers["x-signature"]` (value `undefined`) into this
guard would hit `undefined.startsWith` → an **unhandled
TypeError → HTTP 500** on the security boundary, instead of a
clean "unauthorized → false". A guard that *crashes* on a
missing signature is worse than one that rejects it: it leaks
a 500 and can mask intent. The body of the function (hex-length
regex + Node `timingSafeEqual`) is otherwise correct and
timing-safe — this is purely the missing fail-closed entry
guard. Coverage was also thin: the test only had happy-path +
wrong-secret + non-hex; the security-critical
wrong-length / tampered / case / non-string rejections were
unlocked.

## Scope

- `packages/shared/src/index.ts`: add
  `if (typeof signature !== "string") return false;` as the
  first statement of `verifyHmacSha256Hex` — a non-string
  (incl. `undefined`/`null` arriving despite the type) now
  fails closed instead of throwing. Everything else (the
  `sha256=` strip, the `/^[0-9a-f]{64}$/iu` length guard, the
  `timingSafeEqual` constant-time compare) is unchanged.
- `packages/shared/test/shared.test.ts`: a new case locking
  the rejection invariants — uppercase hex still verifies
  `true` (case-insensitive regex); a tampered but
  still-64-valid-hex signature → `false`; wrong-length hex
  (63 / 66 chars) → `false` **without** crashing
  `timingSafeEqual` on a buffer-length mismatch; empty string
  → `false`; and `undefined` / a number signature → `false`
  (no `.startsWith` TypeError).

## Verify

- `pnpm --filter @muse/shared test` — 9 pass (1 new; existing
  happy-path / wrong-secret / non-hex unchanged).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Pure deterministic crypto guard — no model invoked; the
  unit tests are the authoritative verification (same stance
  as the deterministic-helper goals 194/210/214/218). No
  smoke:live needed.

## Status

done — the HMAC verification guard now fails closed on every
malformed signature shape (missing/non-string, wrong-length,
tampered, empty), never throwing a 500 on the webhook
security boundary, with the rejection invariants pinned by
tests. The constant-time compare and hex-length validation
were already correct and are untouched.
