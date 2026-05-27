# 565 — `muse feeds list --json` and `muse feeds today --json` envelopes add `total` field (CLI list-command convention parity)

## Why

The CLI list-command `--json` envelope convention established by
goals 552 (`muse actions --json`) and 553
(`muse objectives list --json`) — and predated on the
`muse followup list --json` / `muse remind list --json` /
`muse tasks list --json` surfaces — uniformly emits a `total`
field alongside the list array:

| Command | Envelope |
| --- | --- |
| `muse actions --json` | `{ entries, result, total, user }` (552) |
| `muse objectives list --json` | `{ objectives, status, total, user }` (553) |
| `muse followup list --json` | `{ followups, status, total }` |
| `muse remind list --json` | `{ reminders, status, total }` (551) |
| `muse tasks list --json` | `{ tasks, status, total }` |

The two `muse feeds` JSON surfaces were the outliers:

```ts
// muse feeds list --json — pre-fix
io.stdout(`${JSON.stringify({ feeds: store.feeds.map(...) }, null, 2)}\n`);

// muse feeds today --json — pre-fix
io.stdout(`${JSON.stringify({ hours, entries: rolled }, null, 2)}\n`);
```

No `total`. Scripted consumers had to compute `.feeds.length` or
`.entries.length` themselves — extra fragility when the envelope
shape grows in a future iteration. Aligning these two to the
convention closes the last visible asymmetry I can find on the
CLI `--json` surface.

## Slice

- `apps/cli/src/commands-feeds.ts` — `muse feeds list --json`
  envelope now `{ feeds, total }`; `muse feeds today --json`
  envelope now `{ entries, hours, total }`. Both `total` values
  equal the corresponding list's length. The `feeds` `--json`
  for list pulls the `.map(...)` result out into a `const` so
  the same value is read for both the array and the count
  (preventing a future bug where the two diverge).
- `apps/cli/test/program.test.ts` — one focused `it(...)`
  covering both surfaces: a 2-feed store with one recent entry
  rolls to `total: 2` for list and `total: 1` for today.

## Verify

- New `it(...)` green; full `@muse/cli` suite green (1002
  passed, +1 vs baseline 1001, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing `total` from
  the `muse feeds list --json` envelope makes the new test
  fail with `expected undefined to be 2: feeds list --json
  must carry total (convention parity with goals 552/553)`.
  Fix restored, suite back to all green. The `today` envelope
  has a byte-identical shape and would mutate-fail identically;
  cross-surface convention is to test one representative when
  the two are byte-identical.
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 1002 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows only
  the three intended files.
- Pure CLI rendering — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the two
  `muse feeds` programmable surfaces, not the model loop.

## Status

Done. A future grep for CLI list-style `--json` envelopes
without a `total` field on `apps/cli/src/commands-*.ts`
should return zero hits. The `--json` envelope convention is
now uniform across every list-style command in the codebase.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
convention-parity polish on two existing programmable
surfaces, recorded honestly with this backlog row — not a
false metric.

## Decisions

- Added `total` (not `count`) to match the established
  convention. The four other `--json` list envelopes
  uniformly use `total`. Cross-command convention wins.
- For `feeds today --json` the order is now `{ entries,
  hours, total }` (alphabetical key order). The pre-fix
  order was `{ hours, entries }`. JSON.stringify preserves
  insertion order; the alphabetical order matches the
  envelope shape used in goals 552/553 (alphabetical
  `entries, result, total, user`). Consistency wins over
  preserving the pre-fix order.
- Did NOT add `--user` or filter fields to the feeds
  envelope. Reason: feeds are a single shared global
  store; there's no user-scoping or filter dimension to
  echo. The minimal envelope (`feeds, total` and
  `entries, hours, total`) is correct.
- Pulled the `.map(...)` result into a `const feeds`
  before stringifying. Reason: read the same value for
  both the array and the count. The pre-fix shape
  inlined the map twice would've been a bug-in-waiting if
  the iteration order or filter changes; this iteration
  proactively fixes that even though the pre-fix only
  had the array once.
- Mutated only the list envelope (one of two) for the
  proof. The today envelope has a byte-identical
  `{ <array>, total }` shape and would mutate-fail
  identically. Cross-surface convention to test one
  representative.
- Step-8 sub-defect-class check: convention-parity on
  existing programmable surfaces is distinct from the
  recent comparator-determinism (551/555/556), validate-
  NaN (562/563), integer-overflow (561), trim-symmetry
  (559), error-UX (564). Fresh defect-class slot.
