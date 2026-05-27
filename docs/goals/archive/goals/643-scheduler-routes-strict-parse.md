# 643 — `parseLimit` and `parseOffset` in `apps/api/src/scheduler-routes.ts` strict-reject lenient-prefix typos / unit-slipped HTTP query params (`?limit=100x` / `?offset=7d`) so a malformed value falls back to the documented default instead of silently honoring its leading digits — sibling-parity with goal 625's CLI strict env-parse

## Why

`apps/api/src/scheduler-routes.ts:parseLimit` and `parseOffset`
were the HTTP query-param helpers driving the
`/api/admin/scheduler/jobs?limit=&offset=` and
`/api/admin/scheduler/jobs/:id/executions?limit=&pageLimit=`
endpoints. Pre-fix:

```ts
function parseLimit(value: number | string | undefined, fallback = 20, max = 100): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function parseOffset(value: number | string | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}
```

`Number.parseInt` is **intentionally lenient**: it reads leading
digits and ignores trailing garbage. So:

| Query                | Pre-fix verdict | Intent             |
| -------------------- | --------------- | ------------------ |
| `?limit=20`          | 20 ✓            | 20                 |
| `?limit=100x` (typo) | **100**         | fallback (50)      |
| `?limit=20px` (CSS slip) | **20**      | fallback (50)      |
| `?limit=7d` (unit slip from `?after=7d`) | **7** | fallback (50) |
| `?limit=five`        | NaN → fallback  | fallback (50)      |
| `?limit=1.5`         | **1** (parseInt floor) | fallback (50) |
| `?limit=1e3`         | **1** (parseInt stops at `e`) | fallback (50) |
| `?limit=0x10`        | **0** (parseInt stops at `x`, returns 0) → fallback | fallback (50) — but on a different code path |
| `?offset=10x`        | **10**          | 0 (fallback)       |

The defect is the same shape as goal 625 (`resolveReplHistoryCap`
on `MUSE_REPL_MAX_HISTORY_ENTRIES`): `parseInt` accepts the
"useful" prefix of garbage, masking the typo. The user's intent
("limit 100, oops typo'd 100x") was probably "use the default,"
not "use 100 anyway."

Defect-class fingerprint: **lenient `Number.parseInt` accepts
leading digits + trailing garbage; should strict-reject the
whole token to fall back cleanly**. Sibling-parity to goal 625
(CLI side, env vars), 18 iterations back. Fresh against the
recent window:

- 642: stream error listener (read side)
- 641: cacheTtlMs finite-guard
- 640: word-boundary keyword matching
- 639: keyword dedup
- 638: lenient base64url decode (auth)
- 637: lenient base64 decode (loopback)
- 636: HTTP timeout
- 635: per-file concurrent write (memory)
- 634: sort tiebreaker
- 633: surrogate-pair truncation

Strict-parse hasn't been hit since 625.

## Slice

- `apps/api/src/scheduler-routes.ts`:
  - Added file-local `STRICT_INT_RE = /^[+-]?\d+$/u` —
    require the WHOLE trimmed token to be a plain decimal
    integer (optionally signed).
  - Added file-local `strictParseInt(value)` helper:
    - Numeric pass-through (fastify may have already coerced).
    - String: trim, regex-check, then `Number(trimmed)`. Bad
      input → NaN (so callers' `Number.isFinite` check rejects).
    - Anything else → NaN.
  - Both `parseLimit` and `parseOffset` route through the new
    helper. Promoted from `function` to `export function` so
    the unit test can pin them directly.
  - One short WHY comment above the regex names the threat
    model (lenient parseInt + concrete query-string examples).
- `apps/api/test/scheduler-routes-parse-helpers.test.ts` (new
  file):
  - Nine tests across two describes:
    - **parseLimit** — well-formed string (`"20"` → 20),
      numeric pass-through (`20` → 20), max cap
      (`"999"` capped at 100), undefined / empty / zero /
      negative → fallback (5 sub-cases), lenient-prefix typos
      → fallback (7 sub-cases: `"100x"`, `"20px"`, `"7d"`,
      `"50; DROP TABLE"`, `"five"`, `"1.5"`, `"1e3"`),
      hex / octal prefix → fallback (2 sub-cases).
    - **parseOffset** — well-formed (string + numeric), 0 /
      negative → 0, lenient-prefix typos → 0
      (3 sub-cases including `"0x10"`).

## Verify

- `@muse/api` suite green (270 passed, +9 vs the pre-iter
  baseline of 261, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting only the
  `strictParseInt` body back to `Number.parseInt(value ?? "",
  10)` makes EXACTLY two of the nine new tests fail —
  parseLimit `"100x"` returns `100` instead of `50` (silent
  prefix-accept), and parseOffset `"10x"` returns `10` instead
  of `0` (same family). The other seven tests pass both pre-
  and post-fix because:
  - Well-formed strings: parseInt + Number(trimmed) produce
    the same result.
  - Numeric pass-through: bypasses the parse path entirely.
  - Empty / whitespace: both `parseInt("")` and `Number("")`
    fail (NaN vs. 0, respectively — both rejected downstream).
  - `"five"`, `"-5"`, `"0"`: both fail in pre-fix and post-fix.
- `pnpm check` green: apps/api 270/270, apps/cli 1101/1101,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean.
- No LLM request/response wire path touched (pagination is
  an admin / observability surface). `smoke:live` doesn't
  apply.

## Status

Done. The scheduler admin endpoints now strict-parse query
parameters identically to the CLI's `MUSE_*` env knobs:

| Query                                | Before                       | After                       |
| ------------------------------------ | ---------------------------- | --------------------------- |
| `?limit=20`                          | 20                           | unchanged                   |
| `?limit=999&max=100`                 | 100 (capped)                 | unchanged                   |
| `?limit=undefined / 0 / -5`          | fallback                     | unchanged                   |
| **`?limit=100x` (typo)**             | **100** (silent accept)      | fallback (**fixed**)        |
| **`?limit=7d` (unit slip)**          | **7**                        | fallback (**fixed**)        |
| **`?limit=1.5` (parseInt floor)**    | **1**                        | fallback (**fixed**)        |
| **`?limit=1e3` (parseInt stops at e)** | **1**                      | fallback (**fixed**)        |
| **`?offset=10x`**                    | **10**                       | 0 (**fixed**)               |
| **`?offset=0x10` (hex)**             | **0** (parseInt stops at x)  | 0 (cleaner via strict)      |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness
/ strict-parse `fix:` on the admin pagination surface.
Recorded with this backlog row.

## Decisions

- **Single `strictParseInt` helper**, not two inline copies.
  The numeric pass-through + string trim + regex check + Number
  cast triplet is identical between parseLimit and parseOffset;
  inlining would drift on a future change.
- **Regex `^[+-]?\d+$`** matches goal 625's pattern exactly.
  Optional sign, then decimal digits only, anchored to both
  ends. Plain decimal — no scientific notation, no leading
  zeros are treated specially.
- **Promoted to `export function`** so the unit test can pin
  the contract directly. Internal-to-api surface; no
  cross-package API churn.
- **Did NOT change `paginate()` or `readNullableNumber()`**.
  `paginate` operates on the already-parsed numbers
  (defensive `Math.max(0, offset)` + `Math.min(500, Math.max
  (1, limit))`); the strict-parse upstream means `paginate`
  receives finite-positive ints (or `parseLimit`'s fallback,
  also finite-positive). `readNullableNumber` is for JSON-
  body numeric fields (`agentMaxToolCalls`, etc.), not query
  strings; it already uses `Number.isFinite` and rejects
  string/non-number inputs. Different surface, different
  contract.
- **Mutation choice.** Reverted only the `strictParseInt`
  body back to `Number.parseInt(value ?? "", 10)`. Two of
  the nine new tests fail with exact pre-fix symptoms (the
  lenient-prefix `?limit=100x` → 100 and `?offset=10x` →
  10). The 261 pre-existing tests pass both pre- and post-
  fix.

## Remaining risks

- **Other apps/api parsers**. The `compat-parsers.ts`
  helpers (`readQueryInteger`, etc.) already use a similar
  strict regex from goal 625's CLI fix. `readNullableNumber`
  in `scheduler-routes.ts` is JSON-body-only, not query-
  string, and already strict on `typeof === "number"`. No
  remaining lenient `parseInt` in the api package.
- **Pagination semantics**. The strict-parse fallback for a
  bad limit/offset means the user sees the DEFAULT page,
  not their requested malformed page. They'll likely retry
  with a correct value. No 4xx error is emitted; the
  semantic is "ignore the typo, use the default" rather than
  "reject the request." Trade-off: simpler client recovery
  vs. silent bypass. The current posture matches the
  fastify ecosystem's tolerance for missing-but-required
  query params, but a future iter could emit a 400 instead.
- **`0x10` (hex prefix)** previously parsed as 0 (parseInt
  stops at `x`); post-fix it falls to the strict check and
  also returns the fallback. Same final result, different
  code path. Documenting in the test for future audit.
- **`?limit=01000` (octal-prefix)** in pre-fix was parsed as
  1000 (parseInt with radix=10 ignores leading zeros);
  post-fix the regex accepts leading zeros so the strict
  check passes and returns 1000. Same behavior. No
  regression.
