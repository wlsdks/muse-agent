# 498 — direct coverage for `inbound-thread-store` (test-only; goal-492 parallel; 458/477/479/480/485/487/491/492/496 class)

## Why

`inbound-thread-store.ts` (`@muse/messaging`) is the
per-channel conversation memory for the inbound reply loop —
the file that makes a channel chat a continuous session so a
user's 2nd message sees the 1st turn's context. Parallel
structure to goal-492's `inbox-reply-cursor` (the dedup
side); together they form the **two halves** of the inbound
responder's persistence layer.

The MAX_TURNS = 12 bound (per thread) is the safety invariant:
without it a busy channel's thread grows forever, bloating the
prompt + disk. The same easy-regression vector goal 492
mutation-proved on `inbox-reply-cursor`: a future
"simplification" PR dropping
`all[key] = merged.slice(Math.max(0, merged.length - MAX_TURNS))`
would silently unbound the thread file. The module had **zero
direct test coverage** — `inbound-threaded-runner.test.ts`
exercises it indirectly but doesn't pin the bound or the
tolerant-load contract.

Same 458/477/479/480/485/487/491/492/496 sanctioned class —
real safety-critical zero-coverage helper, multi-clause
contract, mutation-provable. No `.ts` source change.

## Slice

- `packages/messaging/test/inbound-thread-store.test.ts` —
  new file, 10 focused tests:
  - **readThread tolerance** — missing file / malformed JSON
    / version mismatch all → `[]`; non-turn entries silently
    filtered (bad role / non-string content / missing
    fields); unknown channel key → `[]` (per-channel
    isolation pinned at the read side).
  - **appendThreadTurns** — empty turns is a no-op (no file
    written); merge with prior across calls; per-channel
    isolation; **MAX_TURNS = 12 FIFO bound** (15 in → 12
    kept, oldest 3 dropped); 0o600 mode (the turns hold user
    content).
- `packages/messaging/src/inbound-thread-store.ts` —
  **unchanged** (`git diff --stat` empty; test-only iteration
  mirroring goals 458/477/479/480/485/487/491/492/496
  verbatim).

## Verify

- New test 10/10 green; full `@muse/messaging` suite green
  (166 passed, +10, 0 failed); tsc strict (messaging)
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): replacing
  `merged.slice(Math.max(0, merged.length - MAX_TURNS))`
  with `merged` (no bound) makes the MAX_TURNS test fail
  with the precise pre-fix symptom (`expected 15 to be 12`
  — the per-channel thread grows unbounded) while the other
  9 tests stay green; source restored byte-identical, suite
  back to 10 green.
- `pnpm check` EXIT=0, every workspace green — no regression
  across the `inbound-threaded-runner` consumer;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the one
  intended test file (src is unchanged).
- Pure file-IO + Map logic — no LLM / model request-response
  wire path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. The inbound reply loop's per-channel conversation memory
— the file that gives the user a continuous channel session
— now has direct coverage pinning its tolerant-load,
no-op-empty, merge, per-channel isolation, FIFO bound, and
0o600-perm contract; the MAX_TURNS slice clause is
mutation-proven against the easy "simplify away the bound"
regression. Together with goal 492 (inbox-reply-cursor), the
inbound responder's two persistence files are now both
directly covered.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a 458-class direct coverage
addition on a zero-coverage daemon-safety helper, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Parallels goal 492 (`inbox-reply-cursor`) verbatim in
  shape: the two files share the same safety pattern
  (tolerant-load + FIFO-bound + atomic write + 0o600), and
  their tests should read identically so a future regression
  on either gets the same mutation-proven catch.
- Mutation-proved the MAX_TURNS slice rather than the
  per-channel isolation: isolation is positively pinned by
  the explicit "channel A's history never bleeds into
  channel B" assertion; the slice is the
  *easy-regression-target* (a future PR would argue the
  slice is "redundant when MAX_TURNS is high", not realising
  unbounded growth is the actual concern).
- Test-only (no source change); source restored byte-identical
  (`git diff --stat` empty for `inbound-thread-store.ts`) —
  mirrors the established protocol exactly.
