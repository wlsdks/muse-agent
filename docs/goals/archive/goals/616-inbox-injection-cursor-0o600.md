# 616 — `inbox-injection-cursor.ts:writePersisted` persists with mode `0o600` + post-rename chmod, closing the single-sidecar gap left after the 598/599 file-mode sweep across every other messaging cursor

## Why

`packages/messaging/src/inbox-injection-cursor.ts:writePersisted`
is the cursor that records, **per user**, the timestamp of the
most recent inbox message injected into each chat/channel
prompt. The sidecar file
(`~/.muse/{providerId}-inbox-injection.json`) was being written
with the umask default (`0o644` on most Linux/macOS shells) —
world-readable.

Every other sibling cursor sidecar in the same package had
already been hardened to `0o600` in earlier iters:

| Sidecar                                      | Hardened |
| -------------------------------------------- | -------- |
| `telegram-offset-store.ts`                   | yes (goal 598) |
| `slack-after-store.ts`                       | yes (goal 598) |
| `discord-after-store.ts`                     | yes (goal 598) |
| `inbox-store.ts`                             | yes (goal 599-era) |
| `inbox-reply-cursor.ts`                      | yes |
| **`inbox-injection-cursor.ts`**              | **NO**   |

The injection cursor leaks the same shape of information the
others were locked down for: which provider channels the bot
polls, how often each user's prompt is augmented, and the
per-user activity cadence (the timestamps move whenever the
user has been talking in a given channel). A shared box —
multi-user workstation, dev VM with other tenants, a forgotten
default-permissions deployment — would expose that timeline to
any local reader.

Step-8 redirect: 598/599 are 17+ commits back, outside the
last-10 window (615/614/613/612/611/610/609/608/607/606). File-
mode is not in the recent class set, so a finishing-pass on the
last missed sibling is well-positioned. The fix is a literal
copy of the inbox-store.ts pattern — the strictest of the
hardened siblings.

## Slice

- `packages/messaging/src/inbox-injection-cursor.ts:writePersisted`:
  - `fs.writeFile(tmp, ..., "utf8")` → `fs.writeFile(tmp, ...,
    { encoding: "utf8", mode: 0o600 })`. Sets the mode at file
    creation so the bytes are never world-readable, even
    momentarily.
  - Added `await fs.chmod(file, 0o600).catch(() => undefined);`
    after the `fs.rename(tmp, file)` call. Defense-in-depth
    against the case where rename copies the target file's
    pre-existing mode (some filesystems, some Node versions).
    The `.catch` keeps the function fail-open on platforms
    where chmod is a no-op (Windows-ish).
  - Same exact shape as the `inbox-store.ts:appendInbound`
    pattern from goal 599 — the strictest hardened sibling.
    Both `writeInboxInjectionCursor` and
    `advanceInboxInjectionCursor` route through this single
    helper, so one fix covers both write entry-points.
- `packages/messaging/test/inbox-injection-cursor.test.ts`:
  - One new test in the existing `inbox-injection-cursor`
    describe. Calls `writeInboxInjectionCursor`, asserts
    `statSync(file).mode & 0o777 === 0o600`. Then calls
    `advanceInboxInjectionCursor` (the other write entry-point
    that also routes through `writePersisted`) and re-asserts
    — the mode must survive the second write + rename + chmod
    cycle.
  - Imports `statSync` from `node:fs` (the test file already
    used `mkdtemp` / `rm` from `node:fs/promises`).

## Verify

- `@muse/messaging` suite green (177 passed, +1 vs baseline 176,
  0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  writeFile mode + chmod back to the bare `"utf8"` argument
  makes the new test fail with `expected 420 to be 384` —
  i.e. the file is at `0o644` (the umask default, decimal 420)
  instead of `0o600` (decimal 384). Exact pre-fix symptom.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1046
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. The cursor sidecar is a local file-system
  persistence surface, not HTTP.

## Status

Done. The messaging package's local sidecar file-mode posture
is now uniform across every cursor store:

| Sidecar                                | Before   | After                       |
| -------------------------------------- | -------- | --------------------------- |
| `telegram-offset-store`                | `0o600`  | unchanged                   |
| `slack-after-store`                    | `0o600`  | unchanged                   |
| `discord-after-store`                  | `0o600`  | unchanged                   |
| `inbox-store`                          | `0o600`  | unchanged                   |
| `inbox-reply-cursor`                   | `0o600`  | unchanged                   |
| **`inbox-injection-cursor`**           | **`0o644`** | `0o600` (**fixed**)      |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a security /
defensive-posture parity `fix:` on the last missed sidecar,
recorded honestly with this backlog row — not a false metric.

## Decisions

- **Match the `inbox-store.ts` pattern, not the lighter
  `telegram-offset-store.ts` pattern.** Telegram-offset uses
  only `writeFile mode 0o600` without the post-rename chmod;
  inbox-store uses both. The post-rename chmod is the
  defensive belt-and-suspenders against the (rare but real)
  rename-preserves-target-mode case on some filesystems —
  costs nothing, closes the hole completely. Match the
  stricter sibling.
- **Single helper covers both entry-points.** Both
  `writeInboxInjectionCursor` and
  `advanceInboxInjectionCursor` route through
  `writePersisted`. One edit covers both. No surface duplication.
- **`.catch(() => undefined)` on the chmod**, matching the
  inbox-store pattern. Keeps the function fail-open on
  platforms where chmod is a no-op or unsupported (Windows
  filesystem semantics). The primary `mode: 0o600` on the
  initial write is the load-bearing guarantee; the chmod is
  defense-in-depth.
- **Test pins BOTH write entry-points.** Calling
  `writeInboxInjectionCursor` alone wouldn't catch a
  hypothetical regression that re-introduced a non-0o600
  write path through `advanceInboxInjectionCursor`. Re-asserting
  after `advance()` pins the invariant across both surfaces.
- **`mode & 0o777` masks the file-type bits** before the
  comparison — on Linux a regular file's mode includes
  `0o100000` (S_IFREG); the `& 0o777` strips that so the
  assertion compares only the permission triplet.
- **Mutation choice.** Reverted exactly the two relevant
  edits (the writeFile options object and the chmod line).
  The mutation reproduces the pre-fix shape — the realistic
  regression a maintainer might write while "simplifying back
  to a one-line writeFile that doesn't bother with the mode
  argument."

## Remaining risks

- **The race between two concurrent calls to
  `appendInbound` / `writePersisted`** (read-modify-write with
  no mutex) can still produce a lost-update — different defect
  class (concurrency), out of scope for this iter. Same
  concern surfaces in every tmp+rename store in the package;
  see goal 600-era discussion.
- **The `.tmp-<pid>-<Date.now()>` tmp filename** can collide
  within a single millisecond from the same pid. A
  `randomBytes(4).toString("hex")` suffix would close that;
  separate iter.
- **`readPersisted`** has no chmod check on read — it just
  reads. A pre-existing file written under the old umask would
  stay `0o644` until the next write. The next call to
  `writeInboxInjectionCursor` / `advanceInboxInjectionCursor`
  rewrites it through this fix; that's the natural
  remediation path.
- **Other Muse stores outside this package** weren't audited
  in this iter. Spot-check the `@muse/agent-core` checkpoint
  store, the calendar / piper / vision sidecars in a future
  iter.
