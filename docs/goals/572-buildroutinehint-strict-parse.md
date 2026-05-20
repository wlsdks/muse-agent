# 572 — `buildRoutineHint` strict-parses routine hours so prefix-typo'd entries drop instead of silently passing

## Why

A docstring-vs-behaviour gap in `active-context.ts`:

```ts
/**
 * Parse the CSV facts written by `muse routine --apply`. Drops
 * non-integer / out-of-range entries defensively so a corrupted
 * fact can't poison the snapshot.
 */
function buildRoutineHint(...) {
  ...
  for (const raw of hoursFact.split(",")) {
    const n = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(n) && n >= 0 && n <= 23) {
      hours.push(n);
    }
  }
  ...
}
```

The docstring promises "drops non-integer entries defensively".
The implementation uses `Number.parseInt(raw.trim(), 10)`, which
keeps the leading-digit prefix — `parseInt("9x", 10) === 9`,
`parseInt("14abc", 10) === 14`, `parseInt("17pm", 10) === 17`.
Each of those passes the `Number.isFinite + range` check and
lands in the `activeHours` array, silently violating the
contract. The active-hour set then drives the `quiet-hours` gate
for proactive notices, the `muse status` "off-hour" flag, and
the briefing's `(up late / early start)` tone — a typo in user
memory poisons every downstream consumer.

Same strict-parse defect class as goals 554 / 570 / 571 but on a
different package and a different surface (agent-runtime
context-assembly).

## Slice

- `packages/agent-core/src/active-context.ts:435-440` — replaced
  the lenient `Number.parseInt(raw.trim(), 10)` with the
  strict-parse pattern: `if (!/^[+-]?\d+$/u.test(trimmed))
  continue;` regex gate then `Number(trimmed)` + `Number.
  isInteger + range` check. The pre-existing comment about
  defensive dropping now matches the code's behaviour. A
  3-line WHY comment explains why parseInt was wrong here.
- `packages/agent-core/test/active-context.test.ts` — added one
  new `it(...)` immediately after the existing
  out-of-range/NaN test: `"9x, 14abc, 17pm, 20"` must produce
  `[20]` (only the bare-decimal `"20"` survives). The
  pre-existing test (`"9, 25, abc, 14, -1, 20"` → `[9, 14,
  20]`) keeps passing — the new strict-parse rejects
  prefix-typos but still accepts plain decimals and signed
  zeros, so the existing fixture's behaviour is unchanged.

## Verify

- New `it(...)` green; full `@muse/agent-core` suite green
  (647 passed, +1 vs baseline 646, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to the
  pre-fix `Number.parseInt(raw.trim(), 10)` block makes the
  new test fail with `expected [9, 14, 17, 20] to equal
  [20]` — the prefix-parse re-includes the typo'd entries
  exactly as the bug report describes. Fix restored, suite
  back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 249
  passed, apps/cli 1027 passed, packages/agent-core 647
  passed); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the three
  intended files.
- Pure parser — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the
  agent-runtime context-assembly + the downstream
  routine-active-hour consumers (quiet-hours gate,
  status "off-hour" flag, brief tone hint), not the model
  loop.

## Status

Done. `buildRoutineHint` now matches its docstring contract:
"drops non-integer entries defensively" — prefix-typo'd
entries actually get dropped instead of silently keeping the
digit prefix.

A natural follow-up: the same prefix-parse pattern lives in
`apps/cli/src/commands-brief.ts:173` and
`apps/cli/src/commands-proactive.ts:309-310` — two other
sites that parse the SAME `routine_active_hours` fact via
the same lenient `Number.parseInt`. Deferred to keep this
iteration's scope tight; the agent-core fix is the most
load-bearing site (every context assembly hits it) so
fixing it first cuts the blast radius.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
strict-parse hardening on the agent-runtime routine
parser, recorded honestly with this backlog row — not a
false metric.

## Decisions

- Strict regex `/^[+-]?\d+$/u` gate before `Number()`.
  Same shape goals 554 / 561 / 570 / 571 use. The
  `Number(trimmed)` (not `parseInt`) makes the
  "non-decimal but starts with a digit" case explicit:
  `Number("9x") === NaN` (rejected by `Number.isInteger`),
  whereas `parseInt("9x", 10) === 9` (silently included).
  The regex gate + `Number()` is the cross-codebase
  strict-parse convention.
- Allowed leading `+`/`-` signs in the regex (`[+-]?`)
  even though the range check (`n >= 0`) rejects
  negatives downstream. Reason: the docstring's
  "out-of-range entries" exists to catch negative
  values too, and the range check is the single
  source of truth for what's allowed in [0, 23]. The
  parse layer only checks "is this a decimal
  integer at all".
- `Number.isInteger(Number("3.14"))` is false → `3.14`
  drops (regex would also reject because it has a dot,
  but the double check is defence-in-depth). The
  function maintains the existing "integers only"
  promise.
- Did NOT touch the days branch (`daysFact.split(",")`).
  That one's already plain-string handling (no parsing).
- Did NOT change the call sites in `commands-brief.ts` /
  `commands-proactive.ts`. Those parse the same fact via
  separate inline code paths. Fresh iteration target
  whenever this defect class needs another sweep.
- Mutation reverts to the single semantic delta (the
  parse expression). Smallest delta; surgical proof.
- Step-8 sub-defect-class check: strict-parse on
  user-memory facts (agent-core surface) is distinct from
  the recent server-side strict-parse on HTTP query
  parameters (570/571). Different package, different
  surface, different consumer; the broader "strict parse"
  theme spans both but each sub-cluster is a separate
  defect-class slot.
