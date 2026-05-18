# 373 — formatRelativeTime broke its own "≤ 7 d → Nd ago" contract

## Why

`formatRelativeTime` (`apps/cli/src/human-formatters.ts`) is the
JARVIS-facing freshness humaniser — it renders the "last activity
2h ago", "next reminder in 3d" affordances in the brief, `muse
today`, episode/inbox recency, and status tables. It was
**entirely untested** (the `human-formatters.test.ts` suite covered
only `formatCitations` + the absolute formatters) and had a
contract bug.

Every tier promotes on the **rounded** delta — the documented
behaviour and the in-code comment ("59.6s must read 1m ago, not
60s ago; likewise 60m→1h, 24h→1d"): `sec<60`, `min<60`, `hr<24`
each let a value that rounds up to the ceiling fall through to the
next, larger unit. The day tier broke the pattern:

```ts
const day = Math.round(absSec / 86400);
if (day < 7) return pick(day, "d");   // ← strict <, no 7d bucket
return formatLocalDateTime(iso, timeZone);
```

The doc says `≤ 7 d → "Nd ago"`, `> 7 d → full timestamp`. But a
timestamp 6.5–7.0 days old rounds to `day = 7`, fails `day < 7`,
and renders as a raw absolute datetime instead of `"7d ago"`.
Empirically confirmed on the built module: `6.6d ago` →
`2026-05-12 06:36`, `7.0d ago` → `2026-05-11 21:00` (both inside
the ≤7d window, both wrongly absolute), while `6.4d` correctly read
`6d ago`. So the entire 6.5–7.0-day band — a full half-day of the
most recent week — silently lost its human phrasing, the one place
the freshness affordance matters most.

## Scope

`apps/cli/src/human-formatters.ts`: `if (day < 7)` →
`if (day <= 7)`. Now a delta rounding to ≤7 days reads `"Nd ago"`
(7d included), and only strictly-greater (`day ≥ 8`, i.e. > ~7.5d)
defers to the absolute formatter — matching both the documented
contract and the rounded-promotion pattern every other tier uses.
One operator change; no other behaviour touched. The in-file
`Goal 062 —` header marker was stripped while editing (the
recorded comment-policy method for a file under edit).

New `describe("formatRelativeTime")` block in
`apps/cli/src/human-formatters.test.ts` — first direct coverage of
this previously-untested JARVIS-facing function: sub-5s collapse
(`just now` / `in a moment`), past `Ns/Nm/Nh/Nd ago`, future
`in N…`, rounded-promotion at tier ceilings (`59.6s → 1m ago`,
`90m → 2h ago`), the **≤7d regression** (`6.6d`/`7.0d`/`7.4d` →
`7d ago`; `6.4d` → `6d ago`), the > 7d deferral (asserted to equal
`formatLocalDateTime(iso)` so it stays host-tz-robust) and
unparseable-input passthrough. Every expected value was empirically
verified against the rebuilt module before asserting.

## Verify

- `pnpm --filter @muse/cli test` — 666 pass (+13; new describe
  block, 57 suites).
- `pnpm check` — every workspace green (apps/cli 666 incl. the
  `test/` glob, apps/api 165, all packages).
- `pnpm lint` — exit 0.
- goal-227/328 byte scan clean on both touched files.
- No real-LLM request/response path touched — `formatRelativeTime`
  is a pure deterministic display formatter. The deterministic
  suite with pre-write empirical verification is the rigorous
  verification.

## Status

done — the freshness humaniser honours its own "≤ 7 d → Nd ago"
contract (the 6.5–7.0-day band now reads `7d ago` instead of a raw
timestamp), consistent with the rounded-promotion behaviour of
every other tier, and the previously-untested function has direct
coverage including the regression.
