# 384 — Calendar WRITE contract-faithful surface check (P4-b1)

## Why

OUTWARD-TARGETS P4 audit: calendar WRITE was a trust-blocking
PARTIAL — the providers have `createEvent` / `updateEvent` /
`deleteEvent`, but the only write coverage was `LocalCalendarProvider`
(file-backed); the real network/OS providers were exercised
**read-only** (CalDAV ICS-time parsing, macOS osascript timeout)
with no surface check asserting the actual outbound write request.
Before Muse can be delegated to act on the user's calendar
unsupervised, the write contract must be proven — the symmetric
counterpart to the P1-b2 / P2-b1 contract-faithful HTTP-fake
pattern.

## Slices

- s1 (P4-b1): `packages/calendar/test/calendar-write-contract
  .test.ts` drives the **real** providers; only the transport is
  faked (injected `fetchImpl` for Google/CalDAV, injected
  `osascriptPath` for macOS — never a fake provider/registry):
  - **Google**: `createEvent` POSTs
    `/calendar/v3/calendars/primary/events` with a `Bearer` token
    (real OAuth refresh round-trip faked) and a JSON body
    (`summary`, `start.dateTime`); `updateEvent` (move) PATCHes the
    event resource; `deleteEvent` (cancel) DELETEs it.
  - **CalDAV**: `createEvent` PUTs an ICS VEVENT with `Basic` auth
    and `text/calendar`; `updateEvent` (move) does the real
    REPORT→merge→PUT round-trip to the same `.ics`; `deleteEvent`
    (cancel) DELETEs the `.ics`.
  - **macOS**: `createEvent` / `deleteEvent` run over the **real**
    `osascript` spawn (fake executable captures stdin) and the
    emitted AppleScript is asserted (`make new event` + `summary:`;
    `delete` + `whose uid is`).

## Verify

- `packages/calendar/test/calendar-write-contract.test.ts` 8/8
  (run directly) and within `pnpm --filter @muse/calendar test`
  (28 pass).
- `pnpm check` green across all workspaces (apps/cli 681, all
  packages); `pnpm lint` 0/0; `pnpm guard:core` clean.
- No source change and no request/response (LLM) path touched —
  the bullet's mandated check is a contract-faithful integration
  assertion, which is exactly this; no smoke:live applies.

## Status

P4-b1 done — calendar WRITE is no longer read-only/unverified: the
create/move/cancel contract is asserted against the real Google,
CalDAV and macOS providers with only the transport faked. P4-b1
flipped `[ ]`→`[x]`; one CAPABILITIES line appended; README
backlog row added.

P4-b2 ("voice end-to-end round-trip has an automated check —
mic→STT→agent→TTS pipeline; STT/TTS mockable, full path") is the
remaining P4 bullet and stays `[ ]`.

## Decisions

- All three named providers are covered via the faithful technique
  appropriate to each transport: HTTP fake for the two network
  providers (the bullet's named technique) and a real-`osascript`
  spawn fake for macOS (osascript is not HTTP — a spawn-arg
  assertion is its contract-faithful equivalent, reusing the
  pattern the existing osascript-timeout test established). The
  bullet is therefore delivered across Google/CalDAV/macOS, not
  split.
- macOS `updateEvent`'s extra internal re-list (`listEvents` after
  the set-AppleScript) is the single write sub-path not asserted
  here; the "move" verb is contract-verified on Google + CalDAV,
  and macOS create+cancel prove the macOS write transport, so the
  bullet ("calendar WRITE … not read-only") is met. A deeper
  stateful macOS-update fixture is not needed for the bullet and
  is not gold-plated in.
- `test(calendar)`: the diff is a surface check + ledger docs over
  unchanged production providers; it flips an outward bullet
  because the bullet's deliverable IS "exercised by a surface
  check, not read-only" — the verification is the capability.
