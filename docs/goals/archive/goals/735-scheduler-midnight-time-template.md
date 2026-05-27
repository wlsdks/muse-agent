# 735 — fix: scheduled-job `{{time}}`/`{{datetime}}` render midnight as 00:00:00, not 24:00:00

## Why

A fresh-surface bug hunt (scheduler, rotating off the reminders/today
ordering work of 732–734) found a real time-rendering defect in
`dateParts` (`packages/scheduler/src/scheduler-helpers.ts`).

The `Intl.DateTimeFormat` used `hour: "2-digit", hour12: false`. In
the en-US locale `hour12: false` selects the **h24** hour cycle (1–24),
so it renders midnight as **`24`**, not `00`:

```
new Intl.DateTimeFormat("en-US",{hour:"2-digit",hour12:false,timeZone:"UTC"})
  .format(new Date("2026-05-22T00:00:00Z"))  // → "24"
```

`renderTemplateVariables` feeds those parts into the scheduled-job
template substitutions, so a job firing at local midnight produced:

- `{{time}}` → `"24:00:00"`
- `{{datetime}}` → `"2026-05-22 24:00:00"`

This is user-facing: `resolveTemplateJson` (index.ts:266) interpolates
these into a scheduled MCP-tool job's `toolArguments` before dispatch,
and `renderTemplateVariables` is public API used for agent-job prompts.
So a midnight digest / daily job sent a nonsensical `24:00:00` to the
tool or LLM — and `2026-05-22 24:00:00` is ambiguous (24:00 conventionally
reads as the *next* day's midnight), risking a wrong-day interpretation.

Same family as 717 (quiet-hours HH:MM) / 722 (ICS TZID) — a clock/time
edge case that only surfaces at a boundary value.

## Slice

- `dateParts`: replace `hour12: false` with `hourCycle: "h23"` (0–23),
  so midnight is `00`. No other field changes.

## Verify

- `@muse/scheduler` scheduler-helpers.test.ts (new `renderTemplateVariables`
  block): midnight `{{time}}` → `00:00:00`, `{{datetime}}` →
  `2026-05-22 00:00:00`; a midday time + `{{date}}`/`{{job_name}}`
  substitution unchanged; a job-timezone case (`Asia/Seoul`, where
  `15:00Z` is local midnight) → `2026-05-23 00:00:00`.
  **Mutation-proven** — reverting to `hour12: false` fails with the
  literal `24:00:00`.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). No model
  request/response path touched (deterministic template rendering) —
  no `smoke:live`.

## Decisions

- **`hourCycle: "h23"`, not a post-format `"24"`→`"00"` patch** — the
  formatter option is the root cause; expressing the intent (0–23
  clock) is clearer and also correct for any locale, vs. string-fixing
  the output.
