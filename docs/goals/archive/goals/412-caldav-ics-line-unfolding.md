# 412 — CalDAV ICS line unfolding (RFC 5545 §3.1)

## Why

Correctness fix on a fresh axis (the `@muse/calendar` CalDAV
parser — never touched by the recent
CLI/policy/mcp/briefing-wiring cluster), high downstream leverage:
calendar events feed `muse today`, the proactive surfacing daemon,
and the situational briefing's `Upcoming:` — a wrong event title
degrades the core JARVIS ambient experience everywhere.

`parseVEvent` matched `SUMMARY` / `LOCATION` / `DESCRIPTION` /
`DTSTART` directly on the raw ICS with **no line unfolding**. RFC
5545 §3.1 requires that a content line longer than 75 octets is
*folded* by inserting CRLF + a single space/tab, and a parser MUST
delete that exact pair before reading properties. The matcher
regex stops a value at the first CR/LF, so any folded property was
**silently truncated at the fold** and the continuation lost.

This is not a rare edge: every mainstream CalDAV server (Google
Calendar, Nextcloud, Radicale, Fastmail) folds *any* line past 75
octets, so a normal-length meeting title/location/notes is enough
to trigger it. A grep confirmed no unfold existed anywhere in the
package and `decodeXmlText` only does XML-entity decoding — the
truncation was unmitigated and untested.

## Slice

- `packages/calendar/src/caldav-provider.ts` — add `unfoldIcs`
  (`/\r\n[ \t]/g` then `/\n[ \t]/g` — lenient to bare-LF folds
  some non-conformant servers emit) and apply it once at the top
  of `parseVEvent` before any property match. Raw CR/LF never
  appears inside a valid ICS value (value newlines are the escaped
  literal `\n`), so removing the exact CRLF+WSP fold pair cannot
  corrupt content.
- `packages/calendar/test/calendar.test.ts` — regression in the
  existing CalDAV describe: a VEVENT whose `SUMMARY` (mid-word
  fold), `LOCATION` (fold + `\,` escape), and `DESCRIPTION`
  (TAB-fold) are folded is now reconstructed in full, and the
  fold doesn't corrupt the following `DTSTART`. Fails on the
  pre-fix code (each value truncated at the fold).

## Verify

- `@muse/calendar` calendar.test.ts 21/21 (20 prior + 1 new);
  both calendar test files 29/29.
- `pnpm check` EXIT=0, every workspace green (apps/cli 717, …);
  tsc strict (calendar) clean; `pnpm lint` 0/0; `pnpm guard:core`
  clean; byte-scan clean (the `\r\n\t` in the fixture are JS
  escapes, not raw control bytes).
- Deterministic ICS parsing, no request/response (LLM) path — no
  `smoke:live` applies. Calendar is consumed by the apps/api
  briefing path so the full `pnpm check` was the gate.

## Status

Done. A folded `SUMMARY`/`LOCATION`/`DESCRIPTION` from a real
CalDAV server is now reconstructed in full instead of being
chopped at octet 75, so `muse today` / proactive notices / the
situational briefing show the complete event title and location.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a correctness fix to an existing feature,
recorded honestly as a `fix(calendar):` change with this backlog
row — not a false metric.

## Decisions

- Unfold once at the `parseVEvent` entry rather than teaching
  every matcher about folds: a single canonical step is the RFC's
  own model (unfold → then parse) and keeps the matchers simple.
- Lenient bare-LF unfolding in addition to strict CRLF: some
  CalDAV servers (and the XML transport) normalise line endings,
  so requiring CR would re-introduce the very truncation on those
  servers — the lenient form is standard practice and cannot
  match inside a valid value.
