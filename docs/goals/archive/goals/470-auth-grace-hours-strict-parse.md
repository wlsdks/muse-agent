# 470 — `muse auth rotate-jwt --grace-hours` strict-parses its value (414/444/463/469 sibling, safety path)

## Why

`muse auth rotate-jwt --grace-hours <n>` controls how long the
**old JWT signing secret keeps verifying tokens** after a
rotation — a security-relevant window. The action parsed it with
lenient `Number.parseFloat(options.graceHours)`:

- `--grace-hours 24x` → `24`
- `--grace-hours 2d` (meant 2 days) → `2` hours — the old secret
  expires **46 h earlier** than intended, prematurely
  invalidating live tokens.
- `--grace-hours 30m` → `30` hours; `--grace-hours 1.5h` → `1.5`.

The code *already* has a guard that demonstrates the intent to
reject malformed input —
`if (!Number.isFinite(graceHours) || graceHours < 0) { stderr
"--grace-hours must be a non-negative number"; exit 1 }` — but
`Number.parseFloat` reads the leading number and discards the
rest, so a typo / unit-slip slips **past** that guard as its
numeric prefix. This is the exact lenient-parse defect class
(414 / 444 / 463 / 469), here on a user-facing safety flag where
the existing validator already proves the bad input *should* be
rejected — closing the hole hardens an existing guard, it does
not add a speculative one. `--grace-hours` is the natural place
for a unit-slip because the value is a time quantity.

`commands-auth.ts` had **no direct test** (only indirect
registration via `program.test.ts`), and the validation otherwise
runs inside an action that writes the real
`~/.muse` rotation file — so the parse was genuinely
uncovered and not unit-testable in place.

## Slice

- `apps/cli/src/commands-auth.ts` — extracted the parse+validate
  into a pure exported `parseGraceHours(raw)`: undefined / empty
  flag → the documented `24` default; otherwise the **whole
  trimmed token** must be a clean numeric literal via `Number`
  (not `Number.parseFloat`) and be a finite `>= 0` → else
  `undefined`. The action now calls it and emits the **identical**
  `--grace-hours must be a non-negative number` error on
  `undefined`. Byte-identical for every input the old code
  accepted or already rejected (`"24"`→24, `"0.5"`→0.5, `"  12  "`
  →12, `"abc"`/`"-5"`/`"   "`/`"Infinity"`→error); only the
  silently-accepted lenient-prefix typo/unit-slip path changes.
- `apps/cli/src/commands-auth.test.ts` — first direct
  `commands-auth` test: default (unset/empty → 24); clean
  integer + decimal values accepted; the lenient-prefix /
  unit-slip set (`24x`, `2d`, `30m`, `1.5h`, `12abc`, `abc`,
  `-5`, `   `, `NaN`, `Infinity`) all → `undefined` (rejected).

## Verify

- New test 3/3 green; full `@muse/cli` suite green (756, +3, 0
  failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting `Number` →
  `Number.parseFloat` makes the rejection test fail with the
  precise pre-fix symptom (`"24x" must not be silently accepted:
  expected 24 to be undefined` — the typo'd grace window
  silently honoured as 24 h) while the default + clean-value
  tests stay green; fix restored, suite back to green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure CLI flag parsing — no LLM / model request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A typo'd / unit-slipped `--grace-hours` (e.g. `2d`, `30m`,
`24x`) is now rejected with the existing clear error instead of
being silently honoured as its numeric prefix — so a JWT-secret
rotation can no longer install a grace window the operator did
not actually ask for. The 414/444/463/469 strict-parse standard
now covers this safety-flag sibling. Every value the old code
accepted is unchanged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a lenient-parse sibling-asymmetry
correctness `fix:` on a safety surface, recorded honestly with
this backlog row — not a false metric.

## Decisions

- `Number(trimmed)` rather than a `/^[+-]?\d+$/` integer regex
  (used by 463/469): `--grace-hours` legitimately accepts a
  fractional value (`0.5`, `1.5`), so an integer-only regex would
  *regress* a valid input. `Number` rejects trailing garbage
  (`"24x"`→NaN) — exactly the reported defect class — while
  preserving decimals; `0x10`/`1e3` are valid JS numeric
  literals, not typo-prefixes, so accepting them is defensible
  and out of scope for this class.
- Extracted a pure `parseGraceHours` instead of inlining the
  stricter check: the validation otherwise only runs inside an
  action that writes the real `~/.muse` rotation file, so it was
  not unit-testable in place; a tiny pure seam is the minimal
  way to give a safety-relevant parse direct, FS-free coverage
  (the cli-product rule's "command-parser unit tests" intent),
  not gold-plating.
- Preserved the exact error string and exit-code behaviour so
  the only observable change is that malformed input now
  *reaches* the error it was always meant to — no new surface,
  no message churn.
