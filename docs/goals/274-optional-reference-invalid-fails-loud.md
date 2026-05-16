# 274 — a malformed optional `reference` silently anchored to now() (goal 261 class)

## Why

`time_relative` and `next_weekday` (agent-callable core tools the
model composes to build reminders / schedules) take an **optional**
`reference` ISO-8601 timestamp; absent → use the current clock.
Both read it with:

```ts
const reference = readRequiredDate(args, "reference") ?? now();
```

`readRequiredDate` returns `undefined` for **both** "field absent"
**and** "field present but unparseable" — the two are
indistinguishable. So when the model emits a malformed but
non-empty `reference` (`"next week"`, `"whenever"`, a typo'd date,
a non-string), the `?? now()` fallback silently anchors the
computation to **now** and the tool returns a confident, wrong
answer:

- `time_relative` reports a relative phrase ("in 5h", "3d ago")
  measured from the wrong instant;
- `next_weekday` resolves "next Monday" from today instead of the
  intended reference date — a wrong reminder date the agent then
  stamps into a schedule.

This is the same silent-wrong-at-the-input-boundary class goal 261
hardened (a bad value must fail loud, not be silently dropped into
default behaviour). Note `time_relative`'s **required** `at`
already errors on an invalid value — only the optional `reference`
degraded silently, an internal inconsistency.

## Scope

`packages/tools/src/muse-tools-helpers.ts`:

- Add `readOptionalDate(args, key)` → discriminated
  `{ kind: "absent" } | { kind: "invalid" } | { kind: "date"; date }`.
  Absent / `null` / empty-string → `absent` (a model emitting `""`
  for an unset optional means "not provided", matching the prior
  `readRequiredDate` empty-string handling). Non-string or
  unparseable string → `invalid`. Parseable → `date`.

`packages/tools/src/muse-tools-time.ts`:

- `time_relative` and `next_weekday`: read `reference` via
  `readOptionalDate`. `invalid` → `{ error: "reference must be a
  valid ISO-8601 string" }`; `absent` → `now()` (unchanged);
  `date` → that instant (unchanged).

Behaviour-preserving for every previously-working call (absent →
now(), valid → that date); the **only** change is that a
present-but-malformed `reference` now errors instead of returning a
silently-wrong result. No API/schema change; `readRequiredDate`
keeps its other four call sites.

## Verify

- `pnpm --filter @muse/tools test` — 63 pass (was 60; +3). New
  `readOptionalDate` helper unit tests (absent/null/empty → absent;
  unparseable/non-string → invalid; ISO → date) plus tool-level
  regressions: `time_relative` with `reference:"whenever"` and
  `next_weekday` with `reference:"next week"` both return the
  `reference must be a valid ISO-8601 string` error; all prior
  time-tool tests (absent / valid reference paths) stay green.
- `pnpm check` — every workspace green (tools 63, apps/cli 561,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (deterministic
  tool-argument boundary validation). A live Qwen round-trip can't
  reproducibly emit a malformed `reference` on demand, so the
  deterministic unit tests are the rigorous verification — same
  stance as goals 261 / 263 / 268.

## Status

done — `time_relative` and `next_weekday` now fail loud on a
present-but-invalid optional `reference` instead of silently
computing against the current clock, so a composed reminder/schedule
can no longer be quietly anchored to the wrong instant. The
`absent → now()` and valid-reference paths are unchanged.
