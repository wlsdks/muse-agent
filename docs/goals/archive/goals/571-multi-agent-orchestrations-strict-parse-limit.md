# 571 — `GET /api/multi-agent/orchestrations?limit` strict-parses bad input as 400 instead of silently truncating

## Why

Direct goal-570 follow-up. Goal 570 closed the
`GET /api/history?limit` lenient-`Number.parseInt` outlier on
the server side and noted "admin-routes.ts has similar
hand-rolled parseInt — fresh iteration target". A fresh grep
on the four flagged sites showed:

- `admin-routes.ts:85` — already strict (`/^\d+$/u.test(...)` gate)
- `admin-routes.ts:104` — already strict (same gate)
- `admin-routes.ts:107` — already strict (same gate)
- `multi-agent-routes.ts:51` — **lenient** (no gate)

So the actual outlier is `multi-agent-routes.ts`. Pre-fix:

```ts
if (limitRaw !== undefined) {
  const parsed = Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000) {
    return reply.status(400).send({ code: "INVALID_LIMIT", ... });
  }
  limit = parsed;
}
```

`Number.parseInt("20x", 10)` returns 20. `Number.isInteger(20)`
is true. `20 >= 0 && 20 <= 1000`. So `?limit=20x` silently
masqueraded as a valid 20-row request. Same trip-wire as
goal 570 on a different route — different contract (this one
emits 400 on out-of-range; that one falls back silently).

## Slice

- `apps/api/src/multi-agent-routes.ts:51` — added the
  `/^\d+$/u.test(trimmed)` gate inline before `parseInt`.
  If the gate fails, `parsed` is set to `NaN`, which the
  existing `!Number.isInteger(parsed)` check rejects with
  the existing 400 + `INVALID_LIMIT` response. Inline
  rather than using `readQueryInteger` (the helper falls
  back silently; this route's contract is "loud 400 on
  bad input"). Added a 3-line WHY comment.
- `apps/api/test/server.multi-agent-orchestrations-limit.test.ts`
  — new file with 4 `it`s covering: `?limit=20x` → 400;
  `?limit=5min` and `?limit=abc` → 400; valid `?limit=10`
  and missing limit → 200; out-of-range `?limit=10000`
  and `?limit=-5` → 400 (preserves the pre-fix range
  contract).

## Verify

- New tests green; full `@muse/api` suite green (249
  passed, +4 vs baseline 245, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `/^\d+$/u.test(trimmed)` regex gate makes 2 of the 4
  new tests fail (`?limit=20x` and `?limit=5min` no
  longer 400 — they pass through as 20 / 5 since
  `parseInt` strips the suffix). Fix restored, suite
  back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 249
  passed, apps/cli 1027 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the three intended files.
- HTTP query parser — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is
  `GET /api/multi-agent/orchestrations?limit=…` used by
  the web UI + scripted clients, not the model loop.

## Status

Done. A fresh grep for `Number.parseInt(` followed by an
unguarded range check inside `apps/api/src/` returns
nothing — every `?limit`-style integer query parser in the
API now strict-parses bad input upstream of the range
check.

A natural follow-up: the goal 570 + 571 sweep both keep
calling `Number.parseInt` after the regex gate. Switching
to `Number()` (which equally rejects non-decimal) and
`Number.isSafeInteger` (goal 561 convention) would harden
against double-precision rounding on `?limit=
9007199254740993`. Deferred to keep this iteration's
scope tight; the existing range cap (1000) means
precision-loss inputs already trip the range check today.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
strict-parse hardening on the `/api/multi-agent/
orchestrations` HTTP query parser, recorded honestly
with this backlog row — not a false metric.

## Decisions

- Inline the regex gate rather than calling
  `readQueryInteger`. Reason: the route's contract is
  "loud 400 on bad input"; `readQueryInteger` falls back
  silently to the supplied default. Replacing the
  contract would be a wider behaviour change (clients
  that currently see 400 would suddenly get a 200 with
  default-limit results). Inline gate preserves the
  contract.
- `parsed = ... ? Number.parseInt(...) : Number.NaN`
  pattern: when the regex fails, we short-circuit by
  setting NaN and letting the existing `!Number.isInteger`
  check produce the 400 response. This keeps the
  error-emission path single (no second `return reply
  .status(400)` block). The existing error message
  ("limit must be an integer between 0 and 1000") is
  also correct for the typo case ("20x" isn't an
  integer).
- Test coverage spans: typo on the digit prefix
  (`20x`), unit slip (`5min`), bare-junk (`abc`),
  happy path (`10`), missing param, and the pre-existing
  range contract (`10000`, `-5`). The range tests pin
  the contract so a future tightening of the parse
  doesn't accidentally weaken the range check.
- Mutation reverts only the regex gate (one of two
  semantic deltas — the WHY comment is the other but
  doesn't affect runtime behaviour). Smallest delta;
  surgical proof.
- Step-8 sub-defect-class check: server-side strict-parse
  on HTTP query parameters is the SAME sub-defect as
  goal 570 (different route). The "convention parity"
  family is well within Step-8 stagnation territory but
  goal 570 explicitly named this as a deferred sibling.
  One-iteration-per-area-per-sibling scope keeps each
  diff reviewable; goal 572 must redirect to a fresh
  defect class.
