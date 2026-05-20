# 509 — `muse telemetry` render guards against corrupt ms (goal-440/453/459/465/508 sibling on the CLI telemetry render path)

## Why

`apps/cli/src/commands-telemetry.ts` rendered three timestamps
from the `/api/admin/metrics/telemetry/summary` and
`/api/admin/metrics/telemetry/recent` responses by calling
`new Date(ms).toISOString()` with no finite-Date guard:

```ts
const windowStart = new Date(summary.windowStartMs).toISOString();
const windowEnd   = new Date(summary.windowEndMs).toISOString();
// …
const when = new Date(event.recordedAtMs).toISOString();
```

If any one of those ms values arrived corrupt — `NaN`,
`Infinity`, out-of-range (`> 8.64e15`), or the wrong type
(after an API drift) — `toISOString()` throws `RangeError:
Invalid time value` and the **whole telemetry view** crashes
for the operator. `muse telemetry summary` and `muse telemetry
recent` are exactly the commands the user runs when something
is already going wrong (latency spike, token-budget drift); a
crash there is the worst possible time to fail loudly.

Same defect class as goals 440 / 453 / 459 / 465 / 508 — the
finite-Date guard now landed on the messaging-ingress side
(goal 508 / Slack `tsToIso`); this is the analogous defence on
the **CLI render** side of the same wire.

## Slice

- `apps/cli/src/commands-telemetry.ts` — added a pure exported
  helper:
  ```ts
  export function formatRecordedAtIso(ms: number): string {
    if (typeof ms !== "number") return "(invalid)";
    const date = new Date(ms);
    if (!Number.isFinite(date.getTime())) return "(invalid)";
    return date.toISOString();
  }
  ```
  Replaced the three inline `new Date(...).toISOString()` calls
  with `formatRecordedAtIso(...)`. Behaviour byte-identical for
  every clean ms value; only the corrupt path now falls back to
  `(invalid)` instead of throwing.
- `apps/cli/src/commands-telemetry.test.ts` — new file, 4
  focused tests:
  - normal ms → ISO-8601 (0 + a present-day epoch)
  - `NaN` / `±Infinity` → `(invalid)` (would have crashed
    `toISOString`)
  - `±(9e15 + 1)` → `(invalid)` (RangeError defence)
  - wrong type (`undefined`, string, `null`) → `(invalid)`
    (API-drift defence)

## Verify

- New test 4/4 green; full `@muse/cli` suite green (847 passed,
  +4 vs baseline 843, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the helper
  to a bare `return new Date(ms).toISOString();` produces 3 RED
  tests, each with the precise pre-fix symptom — `RangeError:
  Invalid time value` thrown on the out-of-range, NaN, and
  Infinity inputs. The wrong-type test stays green by accident
  (`new Date("1700000000000")` coerces and works), but the
  three Date-range mutations are the load-bearing ones the
  defence guards against. Fix restored, suite back to 4 green.
- `pnpm check` EXIT=0; `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the two intended
  files.
- Pure render helper — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the CLI telemetry render,
  not the model loop.

## Status

Done. `muse telemetry summary` and `muse telemetry recent` no
longer crash when the aggregator response carries a single
corrupt timestamp — the offending field renders `(invalid)` so
the operator still sees the rest of the report. The finite-
Date guard convention (`Number.isFinite(date.getTime())` →
fallback) now covers the four messaging / mcp / CLI render
sites consistently (slack-provider, personal-activity-feed,
personal-status-summary, commands-telemetry).

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry
robustness `fix:` on the CLI telemetry render, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Returned `"(invalid)"` rather than `String(ms)` so the
  operator sees a clear UI marker that the field was corrupt;
  the raw ms still lives in the `--json` output (which
  bypasses `formatRecordedAtIso` entirely via
  `helpers.writeOutput`). The text mode is for humans; the
  JSON mode is for machines — different audiences, different
  shapes.
- Did NOT lift the helper to `@muse/shared`: only three
  callers within one file. A shared helper would invite use on
  paths where `(invalid)` is the wrong fallback (e.g. the
  Slack `tsToIso` returns the raw `ts` string instead). Local
  helper keeps the contract obvious.
- Did NOT add a separate `MAX_DATE_MS = 8_640_000_000_000_000`
  constant: `Number.isFinite(date.getTime())` is
  authoritative — the JS engine enforces the range.
- The wrong-type guard (`typeof ms !== "number"`) is the
  belt-and-braces defence against an API contract drift; the
  test for `undefined` / `null` / string asserts it.
