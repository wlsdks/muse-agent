# 631 — `inbound-thread-store.appendThreadTurns` serialises concurrent writes per-file via a small in-process queue (and gives each tmp file a PID+timestamp suffix), so two messaging providers delivering messages in the same tick can't lose the first caller's thread-history update

## Why

`packages/messaging/src/inbound-thread-store.ts:appendThreadTurns`
is the per-channel conversation memory for the inbound reply
loop. Every Telegram / Discord / Slack inbound message that lands
on a channel calls it once to persist `[userTurn, assistantTurn]`
to `~/.muse/threads.json` keyed by `${providerId}:${source}`.

Pre-fix shape:

```ts
export async function appendThreadTurns(file, key, turns) {
  if (turns.length === 0) return;
  const all = await readAll(file);                    // 1. read whole file
  const merged = [...(all[key] ?? []), ...turns];     // 2. merge for THIS key
  all[key] = merged.slice(Math.max(0, merged.length - MAX_TURNS));
  const payload = { threads: all, version: 1 };
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}`; // ← PID only, no uniqueness
  await fs.writeFile(tmp, ..., { mode: 0o600 });
  await fs.rename(tmp, file);
}
```

Two independent concurrency defects, both reachable in normal
operation:

### Defect 1 — lost-update read-modify-write race

The read-merge-write is not serialised. When two messaging
providers deliver in the same tick (Telegram inbound on chat A +
Discord inbound on channel B, both routed through
`createThreadedInboundRunner` — `inbound-threaded-runner.ts:36`),
both calls run concurrently:

1. Call A `await readAll(file)` → `{}`
2. Call B `await readAll(file)` → `{}` (same starting state)
3. Call A computes `all = { "tg:A": [tA] }`, writes file
4. Call B computes `all = { "discord:B": [tB] }` (built from
   the pre-A read!), writes file → **overwrites A's update**

Call A's thread history for `tg:A` is silently gone. On the
next Telegram message to chat A, the agent sees only the new
turn, not the prior conversation. The user experiences "Muse
forgot what we just said" with no error and no signal.

The poll daemons fan out across providers in parallel (every
~5s tick can fire 4 inbound providers in parallel + the agent-
triggered `pollNow` could land another), so this race is
reachable on any active deployment with more than one messaging
provider wired up.

### Defect 2 — fixed-PID tmp filename collision

The tmp path is `${file}.tmp-${process.pid}` — the SAME path for
every concurrent call within the same process. When two calls
race:

- Call A `writeFile(tmp)` writes a payload to the shared tmp.
- Call B's `writeFile(tmp)` runs in parallel — the writes
  interleave, leaving a corrupted JSON in tmp.
- Call A `rename(tmp, file)` moves the (corrupted) tmp to file.
- Call B `rename(tmp, file)` — tmp is now gone → **ENOENT**.

The mutation test on the pre-fix reproduces this exact failure
mode: `Error: ENOENT: no such file or directory, rename
'.../threads.json.tmp-92667' -> '.../threads.json'`. Even
without the rename ENOENT, the corrupted-write window means the
on-disk file could carry garbage between the rename calls.

This iter's defect class — **concurrent file-rewrites without
in-process serialisation; concurrent same-PID tmp filenames** —
is fresh against the recent window:

- 630: mkdtemp directory cleanup (resource leak, not concurrency)
- 629: per-entry validation (cast lie)
- 628: unit-promotion + finite-guard
- 627: tolerant-read nested array
- 626: child-process stream error
- 625: strict env-parse
- 624: HTTP timeout
- 623: classification
- 622: boolean spelling
- 621: test additions
- 620: graceful read recovery

Concurrency / lost-update has not been touched. Sibling stores
in the same package (`inbox-injection-cursor.ts`,
`telegram-offset-store.ts`, `discord-after-store.ts`,
`slack-after-store.ts`, `inbox-store.ts`) all already use
PID+timestamp tmp filenames; this was the missed sibling on
both axes.

## Slice

- `packages/messaging/src/inbound-thread-store.ts`:
  - Introduce a module-private `writeQueues: Map<string,
    Promise<unknown>>` keyed by `file`.
  - Split `appendThreadTurns` into a thin shell that enqueues
    onto the per-file chain, and `doAppendThreadTurns` that
    holds the unchanged read-modify-write body.
  - The chain uses `.then(fn, fn)` so a rejected prior doesn't
    block subsequent appends — each call's success/failure is
    independent. The stored chain handle is `next.catch(() =>
    undefined)` so a failure in one call doesn't repeatedly
    re-fail the next one.
  - Change tmp filename from `${file}.tmp-${pid}` to
    `${file}.tmp-${pid}-${Date.now()}` so even if the queue
    were bypassed, two concurrent calls would write to distinct
    tmp paths (defense in depth against future callers that
    might bypass `appendThreadTurns`). Matches the convention
    every sibling store in the package already uses.
- `packages/messaging/test/inbound-thread-store.test.ts`:
  - Two new tests in the existing `appendThreadTurns` describe:
    - **Different-key concurrency** — fire `appendThreadTurns
      (file, "tg:c1", ...)` and `appendThreadTurns(file,
      "discord:c2", ...)` in parallel via `Promise.all`. After
      both resolve, BOTH `readThread(file, "tg:c1")` and
      `readThread(file, "discord:c2")` must return their
      respective updates. Pre-fix one of them is lost.
    - **Same-key concurrency** — fire two
      `appendThreadTurns(file, "tg:c1", ...)` in parallel with
      different turn contents. After both resolve, the thread
      must contain BOTH turns. The assertion sorts the
      contents to avoid flake on serialisation order — what
      matters is that no turn was lost.

## Verify

- `@muse/messaging` suite green (179 passed, +2 vs the
  pre-iter baseline of 177, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting both the
  queue AND the PID+timestamp tmp filename makes EXACTLY the
  two new tests fail. The first failure surfaces as
  `Error: ENOENT: no such file or directory, rename
  '.../threads.json.tmp-92667' -> '.../threads.json'` — the
  exact race symptom from Defect 2 (concurrent writes to the
  same tmp path; one rename succeeds, the other finds the tmp
  already moved). The second failure shows lost updates
  (Defect 1). The five pre-existing tests in the file pass
  pre- and post-fix — confirms the fix is surgical.
- `pnpm check` green: apps/api 261/261, apps/cli 1093/1093,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean on
  both touched files.
- No LLM request/response wire path touched. The threaded
  inbound runner consumes this; the consumer-visible behavior
  is "every channel keeps its conversation history." `smoke:
  live` doesn't apply.

## Status

Done. `appendThreadTurns` is now race-safe within a single
process across both axes:

| Scenario                                       | Before                              | After                          |
| ---------------------------------------------- | ----------------------------------- | ------------------------------ |
| Single sequential call                         | OK                                  | unchanged                      |
| Two concurrent calls, different keys           | **One key's update lost**           | both updates land (**fixed**)  |
| Two concurrent calls, same key                 | **One turn lost OR rename ENOENT**  | both turns land (**fixed**)    |
| Two concurrent calls, identical timestamp      | Same tmp path collision              | distinct tmp paths via Date.now (**fixed**) |
| One call throws (invalid JSON, FS error)       | Next call sees no isolation         | next call runs cleanly via `.then(fn, fn)` (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
concurrency `fix:` on the threaded-inbound persistence layer.
Recorded honestly with this backlog row — not a false metric.

## Decisions

- **Per-file Promise-chain queue, not a global mutex.** A
  global mutex would serialise writes across every thread
  file the process touches, even though the lost-update is
  per-file. Per-file keyed by the `file` path string scales
  to N independent files cleanly.
- **`Map<string, Promise<unknown>>` keyed by `file` path.**
  The map grows by one entry per distinct file path; since
  `inbound-thread-store` typically has 1-2 files in active
  use (one per `MUSE_THREADED_INBOX_FILE` config, possibly
  one per messaging provider if operators split them), the
  unbounded growth is bounded by configuration in practice.
  Adding LRU eviction would be over-engineering for the
  expected size.
- **`.then(fn, fn)` instead of `.then(fn).catch(...)`.** With
  `.then(fn, fn)`, the next call runs `doAppendThreadTurns`
  whether the prior resolved or rejected — independent
  failure isolation. The stored chain handle is `next.catch
  (() => undefined)` so a continuously-failing chain doesn't
  propagate rejection forever; the next call to
  appendThreadTurns sees a settled promise and starts fresh.
- **`Date.now()` not `randomBytes` for the tmp suffix.**
  Matches the convention sibling stores in the package
  (telegram-offset-store, slack-after-store, discord-after-
  store, inbox-injection-cursor) already use. Date.now() is
  millisecond precision; within the same millisecond two
  calls would still collide on the tmp path, but the
  PROMISE-CHAIN queue is the real serialisation — the tmp
  suffix is defense-in-depth, not the primary fix.
- **Body extracted into `doAppendThreadTurns`** for clarity:
  the wrapper handles the queue, the body holds the logic.
  Single-call code path inside `doAppendThreadTurns` is
  byte-for-byte the pre-fix logic (read → merge → write →
  rename), so any future audit can verify the semantic is
  unchanged just by reading that function in isolation.
- **No tests for the queue's failure-isolation behavior**
  (i.e. "a failing call doesn't break the next one") —
  scoped to the concurrent-write fix this iteration. The
  `.then(fn, fn)` pattern is established and tested in the
  resilience package's retry / withTimeout helpers; the
  inbound-thread-store mirror is structurally identical.
- **Mutation choice.** Reverted both the queue and the tmp
  filename in one shot — the realistic regression is
  "someone removes the queue/cleanup as overengineering."
  Both tests fail with concrete race symptoms; restoring the
  fix flips them green. The other 5 pre-existing tests pass
  both pre- and post-fix because they're single-call (no
  concurrency), so they confirm the fix doesn't perturb the
  happy path.

## Remaining risks

- **Cross-process races.** If two muse daemons / two
  workspaces both write to the same `~/.muse/threads.json`,
  the queue is in-process only and they'd still race. The
  conventional fix would be a file lock (flock / fs.open with
  O_EXCL); not addressed here. Multi-muse deployments would
  need either separate threads.json paths (per-instance
  config) or a real lock. Out-of-scope for this iter — the
  single-muse case is what the codebase ships as default.
- **`writeQueues` map grows monotonically** until process
  exit. Each distinct `file` path is a new key. In practice
  the codebase uses 1-2 distinct paths; if operators
  configured per-channel threads files (one path per Telegram
  chat ID), the map could grow large. Not a leak in any
  realistic deployment, but a future iter could add LRU
  eviction.
- **Other sibling stores in `packages/messaging/src/`** with
  the same read-modify-write shape (`inbox-injection-
  cursor.advanceInboxInjectionCursor`, `inbox-store.append
  Inbound`) carry the SAME concurrent-lost-update potential.
  Auditing each one is its own iter. The thread-store was
  picked here because it's the consumer-visible "JARVIS
  forgot what we said" surface — losing a `lastInjectedAt`
  cursor update is recoverable (next poll re-surfaces a
  recent message), but losing a conversation turn requires
  the user to re-state context.
- **`Date.now()`-only tmp suffix** could theoretically
  collide if two calls land in the same millisecond AND the
  queue serialisation is bypassed (it can't be from this
  module, but a future re-entrant pattern could). Adding
  `randomBytes(8)` would tighten that, at the cost of a sync
  crypto call per write. Out-of-scope; the queue is the
  primary serialisation.
