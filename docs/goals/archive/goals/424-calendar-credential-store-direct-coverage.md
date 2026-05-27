# 424 — Direct coverage for the calendar credential store

## Why

Security test-coverage gap, asymmetric with its own twin. The
messaging credential store (`FileMessagingCredentialStore`) has a
dedicated `describe` in `messaging.test.ts` (round-trip + a
`mode 0600` assertion). Its structurally-identical sibling
`FileCalendarCredentialStore` — which holds **Google OAuth
refresh tokens / CalDAV passwords** (at least as sensitive) — had
**zero direct test coverage** (grep: no test file references it,
no `0o600`/corrupt assertions anywhere in `@muse/calendar`).
`.claude/rules/testing.md` mandates "direct unit tests for every
export of every helper module — no implicit-only coverage";
goals 407 / 423 set the precedent that security primitives get
pinned directly. A future refactor could silently regress the
`mode: 0o600` (→ world-readable OAuth tokens on a shared box),
the tolerant read (→ a corrupt `credentials.json` crashing the
whole calendar / situational-briefing stack), or the deliberate
`Object.create(null)` prototype-safety — with nothing failing.

This is not speculative churn: it pins the **existing,
documented** contract of an untested security-critical export
(the code already implements all of it), so the value is purely
regression-prevention on credential handling — exactly the kind
of coverage the rules require and goal 407 established.

## Slice

- `packages/calendar/test/credential-store.test.ts` (new, 5
  cases):
  - missing file → `load` undefined / `list` `[]` / `remove`
    no-throw (tolerant first read);
  - save/load/list/remove round-trip + **deep-copy** (mutating
    the input after `save` or the object returned by `load` does
    not alias into the store);
  - persists with **mode 0600** and leaves **no `.tmp-` sibling**
    (atomic rename), with the Windows POSIX-mode skip guard
    mirrored from the messaging precedent;
  - a corrupt / wrong-shape `credentials.json` → behaves as empty
    and a subsequent `save` recovers cleanly (must never crash
    the calendar stack);
  - **prototype-safe**: `load("__proto__"|"toString"|
    "constructor")` on a fresh store is `undefined` (not a bogus
    inherited `{}`), and `__proto__` still round-trips as an
    ordinary key without polluting siblings — pinning the
    `emptyProviderMap()` null-prototype intent.

## Verify

- `@muse/calendar` credential-store.test.ts 5/5; full
  `@muse/calendar` suite green (3 files / 34, +1 file +5); tsc
  strict (calendar) clean.
- `pnpm check` EXIT=0, every workspace green (calendar 34, api
  194, cli 731, …); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean.
- Test-only, no `src` change, deterministic fs-backed store — no
  real model path, no `smoke:live` applies. calendar is consumed
  cross-package so the full `pnpm check` was the gate.

## Status

Done. The calendar credential store now has the same direct
security coverage its messaging twin already had (and more — the
tolerant-read and null-prototype branches, which neither store's
suite previously pinned). A refactor that weakens the 0o600
guarantee, the crash-tolerant read, or the prototype-safety now
fails a fast test.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is test-coverage hardening of an existing
security primitive, recorded honestly as a `test(calendar):`
change with this backlog row — not a false metric. Same
discipline as goal 407.

## Decisions

- Targeted the calendar store specifically because the asymmetry
  (messaging tested, calendar not) made it the genuine gap;
  declined to add redundant tests to the already-covered
  messaging store (banned already-covered churn).
- Added the tolerant-read + prototype-safety pins (uncovered in
  BOTH stores) only here, where the file is new — not as a
  separate sweep of the messaging suite (scope discipline; a
  thin messaging mirror would be low-value churn).
