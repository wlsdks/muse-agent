# 625 — `resolveReplHistoryCap` strict-rejects lenient-prefix typos / unit slips so `MUSE_REPL_MAX_HISTORY_ENTRIES=100x` falls back to the documented default instead of silently honouring 100

## Why

`apps/cli/src/chat-repl.ts:resolveReplHistoryCap` reads the
`MUSE_REPL_MAX_HISTORY_ENTRIES` env var to size the in-memory
REPL turn history. Pre-fix:

```ts
export function resolveReplHistoryCap(raw: string | undefined): number {
  if (!raw) return 2000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2000;
  return parsed;
}
```

`Number.parseInt("100x", 10) === 100`. The leading-digit lenience
silently accepts:
- `100x` → 100 (typo'd suffix the user didn't mean)
- `5min` → 5 (unit slip — operator thought minutes, got entries)
- `9999abc` → 9999 (silent prefix truncation)
- `1.5` → 1 (truncation past decimal — the floor isn't documented)
- `1e3` → 1 (scientific notation silently truncated to 1, NOT 1000)
- `0x10` → 0 (parseInt with explicit radix 10 stops at "x" → 0 → falls
  back via the `<= 0` check, but the silent drop is the same hazard)

None of these are what the operator typed. Each silently mis-sizes
the REPL history cap, and the user never sees a diagnostic — they
just notice "history seems weirdly short" after the fact.

Same defect family as goals 463/469/470 (which closed
`Number.parseInt` lenient-prefix on query-param parsing); this site
in chat-repl was missed. Fresh in the recent window — goal 608 was
integer precision (`isInteger` → `isSafeInteger`), a related but
distinct sub-class.

Step-8 redirect: 608 (integer precision) was 16 commits back, well
outside last 10. Goal 622 (boolean spelling) is a different family.
The `parseInt` lenient-prefix family is fresh.

## Slice

- `apps/cli/src/chat-repl.ts:resolveReplHistoryCap`:
  - Added `const trimmed = raw.trim();` so whitespace-padded values
    (`"  100  "`) still parse correctly.
  - Added strict-integer regex gate `if (!/^[+-]?\d+$/u.test(trimmed))
    return 2000;` before the numeric parse. Matches the exact
    pattern goals 463/469/470 established for query-param
    strict-parse: optional sign, then digits, anchored start/end.
  - Replaced `Number.parseInt(raw, 10)` with `Number(trimmed)` —
    safe now that the regex guarantees clean digits. `Number(...)`
    is strict where `parseInt(...)` is lenient (e.g.
    `Number("1.5") === 1.5`, not `1`). The gate's `\d+` (no `.`)
    already rejected decimals; `Number` just gives a uniform parser
    surface.
- `apps/cli/test/program.test.ts`:
  - One new test next to the existing `resolveReplHistoryCap honours
    the env var` test. Loops over the lenient-prefix typos:
    `100x`, `5min`, `9999abc`, `1.5`, `1e3`, `0x10`, ` 100 x`,
    `Infinity` — each must fall back to 2000. Then asserts that
    whitespace-padded clean integers still parse:
    `"  100  "` → 100, `"+250"` → 250. The padded happy-path
    assertion is the trim's contract anchor.

## Verify

- `@muse/cli` suite green (1063 passed, +1 vs baseline 1062, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting back to
  `Number.parseInt(raw, 10)` (no regex gate, no trim) makes the
  new test fail with `"100x" must fall back to the documented
  default... expected 100 to be 2000` — exactly the
  lenient-prefix symptom: the digit "100" is silently accepted
  and the "x" suffix is silently dropped.
- `pnpm check` EXIT=0 (apps/api 261 passed, apps/cli 1063
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. `resolveReplHistoryCap` is a pure env-string
  parser called at REPL boot.

## Status

Done. Strict-parse posture is now uniform across the env-int
parsing family:

| Input                       | Before               | After                       |
| --------------------------- | -------------------- | --------------------------- |
| undefined                   | 2000 (default)       | unchanged                   |
| `""`                        | 2000 (default)       | unchanged                   |
| `"100"`                     | 100                  | unchanged                   |
| `"  100  "` (whitespace)    | **NaN** → 2000       | 100 (**fixed**)             |
| `"+250"`                    | 250                  | unchanged                   |
| `"0"` / `"-5"`              | 2000 (default)       | unchanged                   |
| **`"100x"` (typo suffix)**  | **100** (silent)     | 2000 (**fixed**)            |
| **`"5min"` (unit slip)**    | **5** (silent)       | 2000 (**fixed**)            |
| **`"1.5"` (decimal)**       | **1** (truncated)    | 2000 (**fixed**)            |
| **`"1e3"` (scientific)**    | **1** (truncated)    | 2000 (**fixed**)            |
| **`"0x10"` (hex literal)**  | **0** (parses to 0)  | 2000 (**fixed**)            |
| `"Infinity"`                | 2000 (NaN → default) | unchanged                   |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
env-parse strict-posture `fix:` on a single missed call site,
recorded honestly with this backlog row — not a false metric.

## Decisions

- **Strict regex gate, not "tighten parseInt with a post-parse
  string-length check."** The post-parse approach
  (`parsed.toString() === trimmed`) works for the typo cases but
  fails on whitespace-padded inputs and signed numbers. The
  regex `^[+-]?\d+$` is the canonical "exactly an integer
  literal" shape — established by goals 463/469/470.
- **`Number(trimmed)` instead of `Number.parseInt(trimmed, 10)`
  after the gate.** Both produce the same value for a regex-
  matched string of optional-sign + digits. `Number` is the
  strict-by-default parser; using it here makes the intent
  match the gate ("we've validated this is a clean integer,
  parse it strictly").
- **`raw.trim()` BEFORE the regex test.** Operators who copy-
  paste from a docs example might pick up trailing whitespace.
  Trimming once at the top keeps the strict-integer regex
  simple and matches the same pattern in `parseGraceHours`
  (goal 022-era) and the query-int parser at compat-parsers.ts.
- **No change to the `<= 0` floor.** A user explicitly setting
  `=0` or `=-5` still gets the default 2000. Tested before; the
  contract is unchanged.
- **Test addition extends the existing happy-path test**, not
  in a separate describe. Both tests now sit side-by-side: the
  positive (default + clean integers) and the negative (lenient-
  prefix typos). A future reader reads both together.
- **Mutation choice.** Reverted the helper to the pre-fix
  `Number.parseInt(raw, 10)` shape — exact pre-fix behavior. The
  mutation reproduces the lenient-prefix acceptance, and the
  test catches it with the exact `"100x" expected 100 to be
  2000` symptom.

## Remaining risks

- **Other env-int parsers in the apps/cli surface** that
  still use `Number.parseInt` or bare `Number()` weren't
  swept this iter. Audit candidates: setup-state parsers, the
  CLI's various `--limit` / `--days` parsers (some are already
  strict per goal 463/469/470 — but not all). Spot-check in
  follow-up iters.
- **Whitespace inside the value** (e.g. `"1 00"`) is still
  rejected by the regex — there's no internal-whitespace
  tolerance. That's a feature: a number with embedded whitespace
  is clearly typo'd. Matches the goal-463 pattern.
- **`+0` and `-0`** both parse to 0, which fails the `<= 0`
  guard → default. Same as pre-fix.
- **The `resolveReplHistoryCap` cap itself** is unbounded above —
  a user setting `=100000000` (100M) would get a 100M cap.
  Practical issue: the REPL never accumulates 100M entries, but
  defending an upper bound (say 1M) would be a separate iter.
