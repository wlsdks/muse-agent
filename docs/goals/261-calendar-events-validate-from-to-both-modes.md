# 261 — `muse calendar events` validated --from/--to only in --local mode

## Why

`muse calendar events` runs in two modes: `--local` (read the
local calendar file directly) and the default API mode (query the
running server). The `--from` / `--to` ISO-timestamp validation
lived **inside** the `if (options.local)` branch:

```ts
if (options.local) {
  const from = options.from ? new Date(options.from) : new Date();
  const to   = options.to   ? new Date(options.to)   : new Date(from + 30d);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("--from / --to must be ISO 8601 timestamps");
  }
  …
} else {
  const params = new URLSearchParams();
  if (options.from) params.set("fromIso", options.from);   // forwarded RAW
  if (options.to)   params.set("toIso",   options.to);
  …apiRequest(path)
}
```

So the same bad input produced two different experiences:

- `muse calendar events --from garbage --local` → a clean,
  actionable `--from / --to must be ISO 8601 timestamps` error.
- `muse calendar events --from garbage` (default API mode) → no
  validation; `fromIso=garbage` is sent to the server, which
  silently falls back to its default window. The user believes
  their `--from` was honoured and gets a **silently-wrong**
  agenda with no error.

Inconsistent error UX, and a silent-wrong-result in the more
common (API) mode.

## Scope

`apps/cli/src/commands-calendar.ts` — `calendar events` action:

- Hoist the timestamp validation **above** the `--local` branch
  so both modes reject an unparseable `--from` / `--to` with the
  same `--from / --to must be ISO 8601 timestamps` error before
  doing any work (no provider read, no API request).
- The now-redundant inner NaN check in the `--local` branch is
  removed — the hoisted guard covers it, and the branch's
  default-derived values (`new Date()`, `from + 30d`) are always
  finite once the supplied inputs are validated. Single source of
  validation, identical message in both modes.

Valid timestamps pass through unchanged; only the
previously-unvalidated API path gains the guard.

## Verify

- `pnpm --filter @muse/cli test` — 560 pass (was 559; +1). New
  test runs `muse calendar events --from not-a-date` in API mode
  and asserts it rejects with the actionable
  `--from / --to must be ISO 8601 timestamps` message **and** that
  no `/api/calendar/events` request was issued (caught before
  `apiRequest`). The existing API happy-path query-param test and
  the `--local` events test stay green — valid inputs and the
  `--local` path are unchanged.
- `pnpm check` — every workspace green (apps/cli 560, apps/api
  155, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (calendar query-param
  validation, no model round-trip), so the deterministic CLI test
  is the rigorous verification.

This iteration also verified — and deliberately did **not**
"fix" — three non-bugs in the calendar path (the `--local`
`.toISOString()` is unreachable-with-NaN because
`LocalCalendarProvider.listEvents` range-filters Invalid dates;
`parseIcsDateValue` strictly validates format and never returns
an Invalid Date, so the import dedupe/`toISOString` crash path is
unreachable). The real, demonstrable inconsistency is the one
fixed here.

## Status

done — `muse calendar events` now gives the same clear "must be
ISO 8601" error for a bad `--from` / `--to` whether or not
`--local` is set, instead of silently shipping garbage to the
server and returning a wrong window in the default mode.
