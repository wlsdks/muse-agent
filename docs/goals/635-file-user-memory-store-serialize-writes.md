# 635 — `FileUserMemoryStore.patch` and `deleteByUserId` route through an in-process per-file queue so concurrent `upsertFact` / `upsertPreference` calls (auto-extract hook firing while `/remember` is mid-flight, or two `/fact` calls landing the same tick) don't clobber each other's user-memory updates

## Why

`packages/memory/src/memory-user-store-file.ts:FileUserMemoryStore`
is the personal-JARVIS user-memory persistence — the file
`~/.muse/user-memory.json` is the source of truth for everything
the agent learns about the user (facts, preferences). Pre-fix
`patch` and `deleteByUserId` did unserialized read-modify-write:

```ts
async upsertFact(userId, key, value) {
  return this.patch(userId, ...);
}

private async patch(userId, mutator) {
  const data = await this.read();     // 1. read whole file
  // ...mutate `data.users[userId]`   // 2. merge for THIS user
  await this.write(next);             // 3. write whole file
  return updated;
}
```

When two writes overlap (very plausible in normal operation —
see "Reachability" below), they race:

1. Call A `await this.read()` → `{ users: {} }`
2. Call B `await this.read()` → `{ users: {} }` (same state)
3. Call A computes `users: { stark: {name: "Tony"} }`, writes file
4. Call B computes `users: { stark: {tone: "concise"} }` (built
   from the pre-A read!), writes file → **overwrites A's update**

Call A's `name` fact for `stark` is silently gone. The agent
loses what the user explicitly told it.

Plus the tmp filename uses `${file}.tmp-${pid}-${Date.now()}` —
millisecond precision. Two writes in the same millisecond
collide on the SAME tmp path; one rename succeeds, the other
hits `ENOENT`. The mutation test on the pre-fix reproduces
exactly that: `Error: ENOENT: no such file or directory,
rename '.../user-memory.json.tmp-58165-1779365506312' ->
'.../user-memory.json'`.

### Reachability

The race surfaces on every realistic deployment with auto-
extract enabled:

- **Auto-extract afterComplete hook** — `packages/memory/src/
  memory-auto-extract.ts:createUserMemoryAutoExtractHook`
  fires AFTER every agent run and calls
  `store.upsertFact(userId, key, value)` for each extracted
  fact (multiple `upsertFact` per turn) plus `upsertPreference`
  for each preference.
- **`/remember` slash command** — `apps/cli/src/chat-repl-
  slash.ts:case "remember"` runs a separate LLM extraction
  and calls `upsertFact` / `upsertPreference` directly.
- **`/fact` and `/pref` slash commands** — direct one-shot
  upserts from the REPL.

A user typing `/remember "I prefer dark mode and tea"`
immediately after the previous turn's auto-extract just fired
puts BOTH paths writing concurrently to the same file. Same
risk for HTTP API surface: `/api/memory/facts/:userId` writes
trigger auto-extract on the same agent's next chat-turn
afterComplete.

This iter's defect class — **per-file concurrent
read-modify-write race in a personal-store; sibling-parity to
goal 631 (inbound-thread-store)** — is the second iteration in
this class within the last 10. Step-8 stagnation guard
threshold is ≥3; under that bound. Different surface (user
memory ↔ inbound thread history), different reachability
(auto-extract + REPL ↔ messaging providers), same structural
defect, same fix pattern.

## Slice

- `packages/memory/src/memory-user-store-file.ts`:
  - Add `private static readonly writeQueues = new Map<string,
    Promise<unknown>>();` — keyed by the absolute file path,
    `static` so two `FileUserMemoryStore` instances pointing
    at the same file share the same queue.
  - Extract `serializeWrite<T>(fn): Promise<T>` private method
    that:
    - Pulls the current chain tail from `writeQueues.get(this.file)`
      (or `Promise.resolve()` for the first call).
    - Builds `next = prior.then(fn, fn)` so a rejection in the
      prior call doesn't poison the chain — each call's
      result/error is independent.
    - Stores `next.catch(() => undefined)` as the new chain
      tail so a continuously-failing chain doesn't propagate
      rejection forever.
    - Returns `next` — the caller gets the result/error of
      THEIR call directly.
  - Wrap the body of `patch` in `this.serializeWrite(async ()
    => { ... })`.
  - Wrap the body of `deleteByUserId` in
    `this.serializeWrite(async () => { ... })`.
  - `findByUserId` stays unwrapped — read-only, doesn't need
    serialization.
- `packages/memory/test/memory-user-store-file.test.ts`:
  - Two new tests in the `FileUserMemoryStore` describe:
    - **Same-user concurrency** — `Promise.all` of
      `upsertFact("stark", "name", "Tony")` +
      `upsertPreference("stark", "tone", "concise")`. After
      both resolve, BOTH the fact AND the preference must be
      in the file. Pre-fix loses one or the other.
    - **Different-users concurrency** — `Promise.all` of
      three `upsertFact` calls for `stark`, `rhodes`, and
      `pepper`. All three users must end up in the file. Pre-
      fix one or two of the writes hit the `ENOENT` race or
      lose to the other.
- `docs/goals/634-run-history-sort-tiebreaker.md`:
  - Byte-hygiene cleanup — the previous iter's goal doc
    re-mentioned the same `👨‍👩‍👧` family emoji that goal
    633's doc had. The U+200D Zero-Width Joiner survived to
    that doc; repo-byte-hygiene test caught it during this
    iter's `pnpm check`. Replaced with textual `U+200D`
    notation. Same fix iters 606+ used.

## Verify

- `@muse/memory` suite green (183 passed, +2 vs the pre-iter
  baseline of 181, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting both
  `patch` and `deleteByUserId` back to bare unserialized
  bodies makes EXACTLY the two new concurrency tests fail.
  The first failure surfaces the ENOENT race symptom directly
  (`Error: ENOENT: no such file or directory, rename
  '.../user-memory.json.tmp-58165-1779365506312' ->
  '.../user-memory.json'`); the second surfaces the lost-
  update symptom. The seven pre-existing tests pass pre- and
  post-fix — confirms the fix is purely additive for the
  single-call path.
- `pnpm check` green: apps/api 261/261, apps/cli 1093/1093,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean
  on the touched source/test files. The doc-634 ZWJ cleanup
  is bundled into this commit.
- No LLM request/response wire path touched — pure
  persistence. `smoke:live` doesn't apply.

## Status

Done. The personal user-memory persistence layer is now race-
safe within a single process:

| Scenario                                       | Before                              | After                          |
| ---------------------------------------------- | ----------------------------------- | ------------------------------ |
| Single sequential upsertFact                   | OK                                  | unchanged                      |
| upsertFact + upsertPreference, same user, same tick | **One write lost**             | both persist (**fixed**)       |
| Two upsertFact calls, different users, same tick | **rename ENOENT race OR one user dropped** | both users persist (**fixed**) |
| Auto-extract afterComplete + /remember in flight | **lost update / ENOENT**       | serialized (**fixed**)         |
| One call throws (sanitize failure)             | next call also corrupted state      | next call runs cleanly via `.then(fn, fn)` (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
concurrency `fix:` on the personal-memory persistence layer.
Sibling-pattern to 631 (inbound-thread-store). Recorded
honestly with this backlog row.

## Decisions

- **`static` Map<file, Promise>** rather than per-instance.
  Two `FileUserMemoryStore` instances constructed with the
  SAME `file` path (e.g. one in the REPL, one in the auto-
  extract hook wired by autoconfigure) point at the same
  on-disk file. A per-instance queue wouldn't catch the race
  between those two instances. Static map keyed by file path
  is the natural granularity — same approach 631 used for
  `inbound-thread-store`.
- **Extracted `serializeWrite<T>` helper.** Two call sites
  (`patch` and `deleteByUserId`) both need the same wrapper.
  Inlining would duplicate the `prior / next / catch` triplet
  and any future fix would have to land twice. The helper
  takes a generic `T` so each caller keeps its own return
  type — `patch` returns `UserMemory`, `deleteByUserId`
  returns `boolean`.
- **`.then(fn, fn)` for failure isolation.** Same pattern as
  631. If the previous call rejected (sanitize failure,
  ENOENT on first read), the next call still gets a chance
  to run cleanly. The stored chain tail is `next.catch(() =>
  undefined)` so a perpetually-failing chain doesn't keep
  rejecting downstream.
- **`findByUserId` is NOT serialized.** It's read-only — a
  read interleaved with a write either sees the pre-write or
  post-write state, both of which are valid (atomic rename).
  No lost-update risk on read.
- **Two tests, not three or more.** Same-user and
  different-users cover the two race types (lost-update
  within a key vs. lost-update across keys). Adding
  delete-while-upsert would test interleaving but the queue
  already serializes ALL writes — that case is dominated by
  the existing two.
- **Bundled the doc-634 ZWJ cleanup into THIS commit.** Same
  reason as iter 634 (which bundled doc-633's ZWJ): the
  byte-hygiene fail surfaced during THIS iter's `pnpm check`,
  fixing it inline keeps unrelated work together.
- **Mutation choice.** Reverted both `patch` and
  `deleteByUserId` back to the pre-fix unwrapped bodies in
  one shot. Both new tests fail with concrete race symptoms
  (ENOENT rename collision + lost update). Restoring flips
  them green. The seven pre-existing tests (single-call paths
  + sanitize behavior) pass both pre- and post-fix, confirming
  the fix is surgical.

## Remaining risks

- **Cross-process races.** Two muse instances (REPL + API
  daemon) both pointing at `~/.muse/user-memory.json` would
  still race; the in-process queue doesn't help. The
  conventional fix is a file lock (flock / fs.open O_EXCL).
  Out-of-scope for this iter — the single-muse case is the
  default.
- **`writeQueues` Map grows monotonically** until process
  exit. Each distinct `file` path is a new key. In practice
  the codebase uses 1 distinct path; if operators configured
  per-user files (one file per user via env), the map could
  grow large. Not a leak in any realistic deployment.
- **Sibling stores still carry the same defect class.**
  `packages/messaging/src/inbox-injection-cursor.ts:advanceInboxInjectionCursor`,
  `packages/messaging/src/inbox-store.ts:appendInbound`,
  `packages/messaging/src/discord-after-store.ts` / `slack-after-store.ts` /
  `telegram-offset-store.ts` — each is a read-modify-write
  on a JSON file with no serialization. Each is its own iter.
  Picked the most-impactful (user memory) first; the cursor
  stores are recoverable on the next poll, but a lost user
  fact requires the user to re-state it.
- **`Date.now()`-only tmp suffix** still collides if two
  writes land in the same millisecond AND somehow bypass the
  queue (they can't from this module, but a future direct
  caller could). Adding `randomBytes` would tighten that at
  the cost of a sync crypto call per write. The queue is the
  primary serialization; the tmp suffix is defense-in-depth.
