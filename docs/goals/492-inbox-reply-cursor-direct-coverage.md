# 492 — direct coverage for `inbox-reply-cursor` (test-only; 458/477/479/480/485/487/491 class)

## Why

`inbox-reply-cursor.ts` (`@muse/messaging`) persists the set of
inbound message keys (`${providerId}:${messageId}`) the
conversational reply loop has **already answered**. It's the
safety guard against the worst messaging-loop failure mode:
double-replying to the user after a daemon restart, an
overlapping tick, or any process flake. `appendReplyCursor`
bounds the persisted set at `MAX_HANDLED = 500` so an
ever-growing daemon doesn't bloat memory + disk indefinitely —
the inbox file itself is trimmed, so older keys can never
reappear.

The module had **zero direct test coverage**: no
`packages/messaging/test/inbox-reply-cursor*.test.ts`, no other
test imported it. Its contract was implicit-only:

- **tolerant loader** — missing / malformed / wrong-version
  files all collapse to an empty Set (the loop just
  re-answers, which is safe-by-idempotency); non-string
  entries silently filtered.
- **no-op empty append** — `appendReplyCursor(file, [])` must
  not write the file (preserves whatever was there).
- **dedupe on merge** — repeat keys across calls don't bloat
  the set.
- **MAX_HANDLED FIFO bound** — adding > 500 keys drops the
  OLDEST first (the bound is the central safety invariant).
- **0o600 mode** — the persisted file holds inbound message
  ids, written with restrictive perms.

The MAX_HANDLED bound is the easy-regression vector: a
"simplification" PR that drops the
`all.slice(Math.max(0, all.length - MAX_HANDLED))` would
silently unbound the file, growing the handled set forever.
458/477/479/480/485/487/491 sanctioned class — real
safety-critical zero-coverage helper, multi-clause contract,
mutation-provable. No `.ts` source change.

## Slice

- `packages/messaging/test/inbox-reply-cursor.test.ts` — new
  file, 8 focused tests:
  - **readReplyCursor tolerance** — missing file / malformed
    JSON / version mismatch all → empty Set; valid shape →
    keys (non-strings filtered).
  - **appendReplyCursor** — empty newKeys is a no-op (file
    not written); keys persist + merge across calls;
    **MAX_HANDLED FIFO bound** keeps the latest 500 and drops
    the oldest 100 when 600 are appended; persisted file has
    mode 0o600.
- `packages/messaging/src/inbox-reply-cursor.ts` —
  **unchanged** (`git diff --stat` empty; test-only iteration
  mirroring goals 458/477/479/480/485/487/491 verbatim).

## Verify

- New test 8/8 green; full `@muse/messaging` suite green (156
  passed, +8, 0 failed); tsc strict (messaging) EXIT=0.
- **Clean-mutation-proven** (Edit-based): replacing
  `all.slice(Math.max(0, all.length - MAX_HANDLED))` with
  `all` (no bound) makes the MAX_HANDLED test fail with the
  precise pre-fix symptom (`expected 600 to be 500` — the
  handled set grew unbounded past the safety invariant)
  while the other 7 tests stay green; source restored
  byte-identical, suite back to 8 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the one
  intended test file (src is unchanged).
- Pure file-IO + Set logic — no LLM / model request-response
  wire path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. The reply-loop dedup safety guard — the file that stops
the daemon from double-replying after a restart — now has
direct coverage that pins its tolerant-load + no-op-empty +
merge + FIFO-bound + perms contract; the MAX_HANDLED bound is
mutation-proven against the easy "simplify away the slice"
regression.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a 458-class direct coverage
addition on a zero-coverage daemon-safety helper, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Pivot from apps/api (488/489/490/491 in apps/cli + apps/api)
  to `@muse/messaging` — distinct package + axis (Step-8 mix).
- Mutation-proved the MAX_HANDLED FIFO bound rather than the
  tolerant-loader paths: the bound is the easy-regression
  clause (a future PR would argue the slice is "redundant when
  Set already dedupes", not realising the dedupe is across
  CALLS but the bound is across the persisted file's lifetime);
  the tolerant-loader paths are positively pinned by their
  own dedicated assertions.
- Test-only (no source change); source restored byte-identical
  (`git diff --stat` empty for `inbox-reply-cursor.ts`) —
  mirrors the 458/477/479/480/485/487/491 protocol exactly.
