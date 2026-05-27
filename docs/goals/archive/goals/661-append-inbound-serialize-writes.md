# 661 — `appendInbound` (the persisted-inbox writer for LINE / webhook messaging providers) routes through an in-process per-file queue so two concurrent webhook invocations can't both read the same `inbox: [...]` snapshot and clobber each other's append at rename time

## Why

`packages/messaging/src/inbox-store.ts:appendInbound`
implements the read-modify-write pattern:

```ts
const existing = await readPersistedRaw(file);     // ← yields
const next = [...existing, message];
const trimmed = next.length > capacity ? next.slice(...) : next;
await fs.writeFile(tmp, ...);                       // ← yields
await fs.rename(tmp, file);                         // ← yields
```

The function's pre-fix docstring claimed "Defensive against
races at the webhook layer: each call rewrites the whole
file atomically." That conflates **crash-safety**
(tmp+rename gives durability against torn writes) with
**concurrency-safety** (atomicity vs serialization).

Real race trace under Fastify's single-event-loop webhook
handler:

1. Webhook **A** enters `appendInbound`, awaits
   `readPersistedRaw` — event loop yields.
2. Webhook **B** enters `appendInbound`, awaits
   `readPersistedRaw` — also gets `inbox: [{id:1}]`.
3. **A** resumes: computes `next = [{id:1}, {id:A}]`,
   awaits writeFile.
4. **B** resumes: computes `next = [{id:1}, {id:B}]`,
   awaits writeFile.
5. **A** awaits rename — file becomes `[{id:1}, {id:A}]`.
6. **B** awaits rename — file becomes `[{id:1}, {id:B}]`.
7. **A's webhook message is lost**.

Or worse on a busy LINE webhook with 20 concurrent events:
the file rename collisions can produce ENOENT / EEXIST
errors that crash the webhook handler, costing a retry +
duplicate-delivery from LINE's retry queue.

The fix is the same pattern goals 631 (inbound-thread-store)
and 635 (FileUserMemoryStore) established: an in-process
`Map<string, Promise<unknown>>` keyed by file path,
chained via `prior.then(run, run)` so the queue advances
through both success and failure.

### Defect class

**Concurrent read-modify-write race** — last hit was goal
635 (26 iters ago, well past the 10-iter rotation window;
0 of last 10 in this class). Fresh against the recent
10-iter window:

- 660: Promise.race timer leak
- 659: HTTP redirect SSRF
- 658: sort comparator tiebreaker
- 657: secret patterns ext (PGP)
- 656: secret patterns ext (PEM)
- 655: path-traversal alt-separator
- 654: PKCE feature
- 653: recursion depth bound
- 652: error msg control-char sanitization
- 651: non-crypto RNG for security token

## Slice

- `packages/messaging/src/inbox-store.ts`:
  - **New module-scoped `writeQueues = new Map<string,
    Promise<unknown>>()`** keyed by file path.
  - **`appendInbound` now wraps** the read-modify-write
    logic via `prior.then(run, run)`. The second `run`
    catches the prior chain's rejection so a one-off
    failure doesn't poison the queue for later writes.
    `writeQueues.set(file, next.catch(() => undefined))`
    suppresses unhandled-rejection warnings on the stored
    chain head.
  - **Extracted `doAppendInbound`** with the original body
    (read, compute, tmp+rename). Pure refactor — same
    semantics inside the critical section.
  - Updated the docstring to describe both crash-safety
    AND concurrency-safety.
- `packages/messaging/test/messaging.test.ts`:
  - **One new test** "serializes concurrent writes":
    20 simultaneous `appendInbound` calls via
    `Promise.all(Array.from(...))`. Asserts:
    1. Final inbox length is exactly 20 (none lost).
    2. All 20 message IDs are unique and present in the
       final file (no clobber, no skip).

## Verify

- `pnpm --filter @muse/messaging test`: 180 passed (179
  prior + 1 new). `pnpm check` full: every workspace
  green; tsc strict EXIT=0.
- **Clean-mutation-proven**: removing the queue-wrapping
  block (so `appendInbound` calls `doAppendInbound`
  directly without the chain) makes EXACTLY the new
  concurrency test fail — pre-fix the 20 parallel calls
  collide on the rename step and the test fails with an
  fs.rename error during execution (the rename target is
  swapped under N parallel writers). The 5 pre-existing
  inbox-store tests (sequential append, perms, capacity
  trim, malformed read, etc.) pass either way. Restored;
  all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched. The webhook
  inbox is the bridge between LINE / Discord / Slack /
  Telegram inbound and the agent's inbox-surface. The
  agent path itself doesn't run here. `smoke:live`
  doesn't apply.

## Status

Done. The persisted webhook inbox no longer loses messages
under concurrent webhook delivery:

| Scenario                                              | Pre-fix                                          | Post-fix                              |
| ----------------------------------------------------- | ------------------------------------------------ | ------------------------------------- |
| Sequential `appendInbound` (single-shot)               | works                                            | unchanged                             |
| 2 concurrent webhooks (same file)                      | one message lost OR rename-collision throws      | both messages persisted, FIFO order   |
| 20 concurrent webhooks (LINE retry storm)              | typically 1-15 messages lost + occasional ENOENT | all 20 messages persisted             |
| File-system crash mid-write                            | tmp+rename keeps file atomic                     | unchanged (crash-safety preserved)    |

## Decisions

- **Module-scope Map**, not a per-instance one. The free
  function `appendInbound` has no `this`; the natural
  key is the file path. Different operators / different
  files have independent queues.
- **`.then(run, run)`**, not `.then(run).catch(run)`.
  The second arg-form ensures the queue keeps advancing
  on the prior chain's rejection without re-triggering
  the current write — `then(fn).catch(fn)` would run `fn`
  twice when prior rejects (once via .catch, but the
  .then chain already failed). This is the same pattern
  goals 631/635 used.
- **`writeQueues.set(file, next.catch(() => undefined))`**.
  Storing the catch-suppressed promise on the queue head
  prevents Node's UnhandledPromiseRejection warning when
  a write fails — the caller still gets the rejection
  via the original `next` returned, but the stored chain
  head is safe.
- **Did NOT touch readInbox**. Reads are idempotent and
  don't conflict with each other or with a single
  in-flight write (the writer's tmp+rename is atomic at
  the filesystem level). Goal 635 followed the same
  scope-bounding logic.
- **20 concurrent writes in the test**. Empirically
  enough to force the rename collision pre-fix on
  typical Linux+APFS+ext4. A smaller N (5-10) sometimes
  passes nondeterministically. 20 catches the race
  consistently.
- **Mutation choice**. Reverted the entire queue-
  wrapping block (so `appendInbound` calls
  `doAppendInbound` directly). The concurrency test
  fails on the rename collision; the 5 sequential
  tests pass regardless. Surgical proof.

## Remaining risks

- **Cross-process concurrency** isn't bounded by the
  in-process Map. Two `muse-api` workers (clustered
  mode) writing the same inbox file would still race.
  An advisory-lock layer would be needed for that —
  out of scope; Muse runs single-process today.
- **The queue grows for the lifetime of the file**
  reference, but the stored Promise is replaced on
  each call — no accumulation of completed chains.
  The Map entries themselves accumulate one entry
  per distinct file path; for the typical single-file
  inbox that's a Map size of 1.
- **`fs.chmod` failure suppressed via `.catch(() =>
  undefined)`**. Already the case pre-fix; behavior
  preserved.
- **Other read-modify-write sites in messaging** that
  might have the same shape:
  - `packages/messaging/src/discord-after-store.ts` —
    cursor file, single-line state, but does
    read-modify-write. Sibling-fixable.
  - `packages/messaging/src/slack-after-store.ts` — same.
  - `packages/messaging/src/inbox-injection-cursor.ts`
    — cursor file. Sibling-fixable.
  - `packages/messaging/src/inbox-reply-cursor.ts` —
    same.
  - `packages/messaging/src/telegram-offset-store.ts` —
    same.
  Each is its own iter when the rotation circles back.
  The inbox-store fix is the highest-leverage because
  the webhook-storm is the realistic concurrent path.
- **A failed write doesn't poison the queue**, but its
  caller sees the rejection. Webhook handlers should
  catch + log + still return 200 (LINE retries on
  non-2xx). The existing webhook handler
  (`messaging-webhooks-routes.ts`) already does this
  via try/catch around the `appendInbound` call.
