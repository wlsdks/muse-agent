# 674 — `/api/reminders/history` and `/api/proactive/history` parse their `?limit=` through a shared strict `parseHistoryLimit`, so a malformed value (`9.5` / `0x10` / `1e3`) falls back to the store default instead of being silently honored as `9` / `16` / `1000` — sibling-parity with the scheduler-routes strict-parse posture (goals 463 / 643)

## Why

The two history endpoints parsed `?limit=` leniently:

```ts
const limitRaw = query.limit ? Number(query.limit) : undefined;
const limit = limitRaw !== undefined && Number.isFinite(limitRaw)
  ? Math.max(1, Math.min(500, Math.trunc(limitRaw)))
  : undefined;
```

`Number(...)` is lenient, so a typo / unit-slip / non-decimal
literal is silently honored:

- `?limit=9.5` → `Number` 9.5 → `Math.trunc` → **9**
- `?limit=0x10` → `Number` **16** (hex literal)
- `?limit=1e3` → `Number` 1000 → clamp → **500** (scientific)
- `?limit=30s` → `Number` NaN → falls through (this one was OK)

Goal 643 already established the opposite, stricter posture
for the scheduler routes: a malformed `?limit=` should fall
back to the documented default rather than silently honoring
the leading digits / hex / scientific interpretation. These
two history routes were the inconsistent holdouts — one route
family rejects `9.5`/`0x10`, the other quietly accepts them.

The fix extracts a shared `parseHistoryLimit(raw, max)` into
`server-input-utils.ts` (strict: `/^\d+$/` + `Number.isInteger`
+ `> 0`, returns `undefined` for absent/malformed so the store
falls back to its own default) and routes both endpoints
through it.

### Defect class

**Lenient `Number()` parse where a strict integer parse is
the established convention** (consistency / strict-parse).
Strict-parse is 1 of the last 10 iters (671 was the related
asymmetric-validation fix; the actual strict-int-parse class
last landed at 643, well outside the window). Fresh AREA (API
history routes) — distinct from the recent calendar (670,
673) and messaging (668, 669, 672) runs, keeping the
stagnation guard's "don't churn one area" rule satisfied.

Recent 10-iter window:

- 673: Math.min/max spread RangeError (calendar)
- 672: HTTP timeout (LINE)
- 671: asymmetric validation (web-search)
- 670: calendar local-timezone render
- 669/668: HTTP timeout (messaging)
- 667/666: route to synthesizeAndPlay
- 665/664: scheduler bounds

## Slice

- `apps/api/src/server-input-utils.ts`:
  - **New `parseHistoryLimit(raw: string | undefined, max:
    number): number | undefined`** + a module-local
    `STRICT_INT_RE = /^\d+$/u`. Returns `undefined` when the
    param is absent OR not a plain positive decimal integer;
    else clamps to `max`. A WHY comment cites the
    scheduler-routes parity.
- `apps/api/src/reminders-routes.ts`:
  - `/api/reminders/history` now does `const limit =
    parseHistoryLimit(query.limit, 500)` (was the inline
    lenient `Number` + clamp).
- `apps/api/src/proactive-routes.ts`:
  - `/api/proactive/history` — same one-line swap.
- `apps/api/test/server-input-utils-parse-history-limit.test.ts`
  (new file):
  - **Four tests**: well-formed positive integer; clamp to
    max; absent → `undefined`; and a loop over `["9.5",
    "0x10", "1e3", "30s", "12abc", "1_000", " ", "", "-3",
    "0", "+5"]` each asserting `undefined` (strict-reject).

## Verify

- `pnpm --filter @muse/api test`: 277 passed (273 prior + 4
  new). Full `pnpm check`: every workspace green; tsc strict
  EXIT=0.
- **Clean-mutation-proven**: reverting `parseHistoryLimit` to
  the lenient `Number(raw)` + `Number.isFinite` + `Math.trunc`
  form makes EXACTLY the strict-reject test fail — `9.5`
  returns 9, `0x10` returns 16, `1e3` returns 500 instead of
  `undefined`. The well-formed / clamp / absent tests pass
  either way. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the four touched files: clean.
- No LLM request/response wire path touched — these are HTTP
  query-param parsers feeding a file-read. `smoke:live`
  doesn't apply.

## Status

Done. Both history endpoints now reject malformed limits
uniformly with the scheduler routes:

| `?limit=`     | Pre-fix (history routes)        | Post-fix                  | scheduler-routes (643) |
| ------------- | ------------------------------- | ------------------------- | ---------------------- |
| `20`          | 20                              | 20                        | 20                     |
| `999`         | 500 (clamped)                   | 500 (clamped)             | capped                 |
| `9.5`         | **9** (truncated)               | **undefined** (default)   | rejected               |
| `0x10`        | **16** (hex)                    | **undefined**             | rejected               |
| `1e3`         | **500** (scientific→clamped)    | **undefined**             | rejected               |
| absent        | undefined                       | undefined                 | default                |

## Decisions

- **Shared helper in `server-input-utils.ts`**, not a
  per-route inline. Both routes had byte-identical lenient
  logic; one strict helper removes the duplication and is
  the single chokepoint to test. The scheduler routes keep
  their own `parseLimit` (different contract — it always
  returns a number with a fallback, never `undefined`),
  noted below.
- **Returns `undefined` for malformed**, not a default
  number. The history stores (`readReminderHistory`,
  `readProactiveHistory`) take an optional `limit` and apply
  their OWN default when it's `undefined` — preserving the
  pre-fix "absent → store default" contract. A malformed
  value now joins the absent case (→ store default) rather
  than silently honoring a wrong number.
- **`/^\d+$/` (no sign)** — a history limit is a plain
  positive count; `+5` / `-3` are rejected (the `> 0` check
  also catches `0` and any negative that slipped the regex).
  Matches the scheduler-routes `STRICT_INT_RE` intent
  (scheduler's allows a leading sign but then the value
  check rejects non-positive; this one rejects the sign at
  the regex for a tighter contract on a count).
- **Did NOT consolidate with scheduler's `parseLimit`** —
  different return contract (number-with-fallback vs
  `undefined`-when-absent). Forcing one signature would
  muddy both. Two small strict parsers with clear contracts
  beats one overloaded one.
- **Mutation choice** — reverted to the lenient `Number()`
  form. The strict-reject test fails (9.5→9, 0x10→16,
  1e3→500); the valid/clamp/absent tests pass. Surgical
  proof.

## Remaining risks

- **`/api/messaging/inbox`** (`messaging-routes.ts:57`) still
  uses `query.limit ? Number(query.limit) : undefined` with
  a `Number.isFinite` + clamp. Same lenient pattern; could
  adopt `parseHistoryLimit` (its max is `MAX_READ_LIMIT`,
  not 500, so it'd pass that). Sibling-fixable. Lower
  priority — it's a single read endpoint, not a history
  audit surface.
- **Scheduler routes keep their own `parseLimit`/`parseOffset`**
  (goal 643) — intentionally, different contract. No
  consolidation needed; both are strict.
- **The `max: 500` is a literal at each call site** — both
  history routes pass 500. A future iter could hoist a
  named `HISTORY_LIMIT_MAX` constant if a third caller
  appears.
- **Fastify may coerce `?limit=20` to a number** before the
  handler in some configs; `parseHistoryLimit` takes
  `string | undefined`, so a numeric arrival would be
  `typeof !== "string"` → `undefined` (store default). In
  practice these routes receive the raw string query; if a
  schema coercion is ever added, the helper would need a
  `number` branch (like scheduler's `parseLimit` has). Not
  a current concern.
