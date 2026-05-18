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

**P4-b2 done — P4 fully delivered (b1–b2).**
`apps/cli/src/commands-listen.test.ts` adds a full-path round-trip
check driving the **real** `registerListenCommand` Phase-C
push-to-talk action; only the I/O boundaries are faked (a fake
`spawnRec` ChildProcess emitting canned WAV, STT, TTS, the
`/api/chat` `apiRequest`, and `playAudio`). It asserts each stage's
data actually flowed: captured WAV bytes → STT; transcript →
`/api/chat` as `{message}`; agent reply → TTS; synthesised audio →
the written file that `playAudio` received. The existing test only
covered the `safeTranscribe` resilience helper — this is the first
automated end-to-end voice round-trip. P4-b2 flipped `[ ]`→`[x]`;
one CAPABILITIES line appended; README backlog row flipped to done.

A `tsc` circular-type error (a self-referential `ReturnType<typeof
helpers.shells["spawnRec"]>`) surfaced under `pnpm check` though
vitest's esbuild transpile passed; root-fixed by typing `helpers`
as the exported `ListenHelpers` and the fake recorder as
`ChildProcess` — not worked around.

Next iteration: per contract Step 4, the P4 target-completion
audit (both P4 bullets `[x]`, no `P4 audit —` line yet).

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
- P4-b2 drives the real `registerListenCommand` action (not a
  re-implemented pipeline) so the test proves the actual
  production composition mic→STT→agent→TTS→playback. The
  `apiRequest` agent call is faked at the established
  `ListenHelpers` seam, so no real LLM round-trip occurs — the
  bullet itself prescribes "STT/TTS mockable, full path", so a
  mocked-boundary integration test is the mandated check (no
  smoke:live applies).
- The two P4 bullets shipped as one goal (384) across two slices;
  this commit is `test(cli)` for the voice slice.
