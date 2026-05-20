# 555 — `filterFresh` adds `messageId` asc tiebreaker (messaging-side sibling of the CLI-render-path comparator-determinism sweep)

## Why

Step-8 redirect from the run of CLI-area iterations (551-554)
into a different package and a different surface — same defect
class. `filterFresh` in `packages/messaging/src/inbox-surface.ts`
is the comparator that orders cross-provider inbound messages
before they're handed to the agent runtime / inbox surface.

The pre-fix comparator:

```ts
const sorted = [...inbox].sort((a, b) => {
  const am = Date.parse(a.receivedAtIso);
  const bm = Date.parse(b.receivedAtIso);
  if (Number.isFinite(am) && Number.isFinite(bm)) {
    if (am !== bm) {
      return am - bm;
    }
  } else if (a.receivedAtIso !== b.receivedAtIso) {
    return a.receivedAtIso.localeCompare(b.receivedAtIso);
  }
  return 0;
});
```

When two messages share the same parsed instant (a webhook
delivering a batch of Slack messages at one millisecond; two
Telegram updates pumped in a single long-poll response), the
comparator falls through to `return 0` — JavaScript's stable
sort yields to file-array insertion order. Across inbox reload
cycles, that order can change whenever anything upstream
reorders the JSON array (the inbox store rewrites on every
append). So the autonomous agent could process the same two
messages in different orders across reloads, breaking the
"identical persisted data → identical processing order"
contract that goals 519/530/531/533/537/546/551 established
on the CLI / API / store render paths.

`InboundMessage` already carries a stable `messageId` field
(it's the provider-supplied id used by the cursor / dedupe
machinery), so the tiebreaker is trivially satisfiable.

## Slice

- `packages/messaging/src/inbox-surface.ts:164` — added the
  asc-by-messageId tiebreaker on the comparator's final
  return:
  ```ts
  return a.messageId.localeCompare(b.messageId);
  ```
  Replaces the bare `return 0`. The two-tier "parseable
  instants compare numerically, unparseable values fall to
  lexicographic ISO" structure stays unchanged; only the
  insertion-order-leak fallthrough is replaced with a stable
  id-based tiebreaker.
- `packages/messaging/test/inbox-surface.test.ts` — added
  one focused `it(...)`: three messages with identical
  `receivedAtIso`, inserted as `["b", "a", "c"]`, must come
  back as `["a", "b", "c"]` through `filterFresh(...)`.

Direction matches the surrounding 533/537/546/551 convention:
asc primary key (parsed instant — oldest first, which is the
correct processing order for an inbox), asc id tiebreaker.

## Verify

- New `it(...)` green; full `@muse/messaging` suite green
  (172 passed, +1 vs baseline 171, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `messageId.localeCompare` tiebreaker to the bare `return 0`
  makes the new test fail with the precise pre-fix symptom —
  `messages sharing the parsed instant must come back in
  messageId asc order: expected [ 'b', 'a', 'c' ] to deeply
  equal [ 'a', 'b', 'c' ]`. Fix restored, suite back to all
  green (172 passed).
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 998 passed, packages/messaging 172
  passed); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the three
  intended files.
- Pure comparator — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the inbox-
  surface message-ordering used by the agent inbox /
  threaded-runner, not the model loop.

## Status

Done. The id-tiebreaker convention now reads identically
across:

- API server-side: `/api/today` reminders/followups/tasks
  (533)
- CLI local-mode renders: `muse followup list`, `muse today
  --local` (537), `muse remind list --local` (551)
- Other persistence-render paths: `vacuumEpisodes` (519),
  `queryActionLog` (530), `suggestPatternHints` (531),
  `compareFeedEntriesNewestFirst` (546)
- **Messaging inbox surface: `filterFresh` (this goal)**

No CAPABILITIES line / no OUTWARD-TARGETS flip: all
P-bullets are already `[x]` and audited; a sibling-asymmetry
comparator-determinism `fix:` on the messaging-side
cross-provider message-ordering, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Step-8 redirect from the recent run of CLI-area iterations
  (551-554) onto a fresh package (`packages/messaging`)
  with the same defect class. Different surface (provider-
  side inbox ordering vs CLI render-path), same convention.
- Direction stays asc primary + asc id (matches 533/537/551).
  The asc-by-instant ordering is correct for an inbox — the
  oldest message gets processed first; the `.slice
  (-perProviderLimit)` after the sort then keeps the newest
  N. Within a tie, asc-by-id is the established sibling
  convention; reader expectation is consistent.
- `messageId` is the existing stable id from the
  `InboundMessage` schema (provider-supplied, used by the
  cursor/dedupe machinery). Cross-package convention is
  always asc-by-id when an id field exists; falling back to
  `text` or `providerId` would break the convention without
  reason.
- Mutated only the final-return token for the proof. The
  two-tier numeric / lexicographic fallback structure was
  left unchanged; that part is already covered by the
  goal-? existing `freshness is by parsed instant, not
  lexicographic ISO` test in the same describe block. One
  fix per iteration; no opportunistic widening.
