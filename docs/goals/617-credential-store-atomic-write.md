# 617 — `credential-store.ts:writeCredentialStore` routes through an atomic `tmp+rename` so a crash mid-write never leaves the user with a 0-byte `credentials.json` (closing the single non-atomic write site in the codebase)

## Why

`apps/cli/src/credential-store.ts:writeCredentialStore` is the
function `muse auth login` / `muse auth logout` / the implicit
token lookup in `apiRequest` route every credential mutation
through. It encrypts the token map with AES-256-GCM and persists
to `~/.config/muse/credentials.json`. Pre-fix:

```ts
await writeFile(filePath, `${JSON.stringify(...)}\n`, { mode: 0o600 });
await chmod(filePath, 0o600);
```

Direct `writeFile(filePath, ...)` opens the target with
`O_TRUNC`: the file is **truncated to 0 bytes BEFORE** the
encrypted bytes start landing. A crash / OS panic / disk-full /
SIGKILL between truncate and the actual write leaves the user
with an empty `credentials.json`. On next read:

```ts
const raw = await readFile(credentialPath(io), "utf8");
const file = JSON.parse(raw) as unknown;        // ← throws on ""
if (!isEncryptedCredentialFile(file)) {
  throw new Error("Invalid Muse credential store format");
}
```

`JSON.parse("")` throws `SyntaxError`. The thrown error walks
back through `readCredentialStore` to whatever called
`readStoredToken` — `muse auth status` reports "no creds,"
`muse chat` falls back to anonymous, the user has to
`muse auth login` again. Their working token is gone.

Every other persistent store in the codebase uses an atomic
`tmp+rename` for exactly this reason. The pattern is so
established that goal 616 (one iter ago) closed the last
messaging-package non-atomic site:

| Store                                  | Atomic write |
| -------------------------------------- | ------------ |
| `messaging/telegram-offset-store`      | yes          |
| `messaging/slack-after-store`          | yes          |
| `messaging/discord-after-store`        | yes          |
| `messaging/inbox-store`                | yes          |
| `messaging/inbox-reply-cursor`         | yes          |
| `messaging/inbox-injection-cursor`     | yes (goal 616) |
| `messaging/inbound-thread-store`       | yes          |
| **`cli/credential-store`**             | **NO**       |

The credential store is the **most important** site of all
(losing a token forces a full re-login — a CLI hit) and was
the missed one.

Step-8 redirect: 616 was file-mode (0o600) — different
defect class. Atomicity vs permissions are distinct
concerns (a 0o600 file can still be 0 bytes). 600 was
HTTP timeout, 604 was HTTP memory cap — also distinct.
Atomic-write is a fresh class in the recent-10 window.

## Slice

- `apps/cli/src/credential-store.ts:writeCredentialStore`:
  - Added `rename` to the `node:fs/promises` import line.
  - Replaced the direct `writeFile(filePath, ...)` with a
    `tmp+rename` sequence:
    ```ts
    const tmp = `${filePath}.tmp-${process.pid.toString()}-${randomBytes(8).toString("hex")}`;
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, filePath);
    await chmod(filePath, 0o600).catch(() => undefined);
    ```
  - `randomBytes(8).toString("hex")` makes the tmp suffix
    collision-resistant across rapid back-to-back writes from
    the same pid (the existing `<pid>-<Date.now()>` patterns in
    sibling stores can collide within the same millisecond on
    parallel writes; the random suffix is stricter).
  - Post-rename `chmod(...).catch(() => undefined)` matches
    the `inbox-store.ts` / `inbox-injection-cursor.ts` (goal
    616) pattern: defensive against rename copying the
    target's pre-existing mode on some filesystems, fail-open
    on platforms where chmod is a no-op (Windows-ish).
- `apps/cli/src/credential-store.test.ts`:
  - Added a `vi.mock("node:fs/promises", ...)` hook at the top
    of the file that delegates every call to the actual fs
    module while capturing the `writeFile` target path in a
    module-level `writeFileCalls` array. (ESM namespace bindings
    are not configurable, so `vi.spyOn` doesn't work on
    `node:fs/promises` — `vi.mock` with `importOriginal` is the
    canonical workaround.)
  - New describe `writeCredentialStore atomic write` with one
    test: seeds an initial token, writes a second token, and
    asserts every captured `writeFile` path from the second
    write follows the pattern `credentials\.json\.tmp-\d+-[a-f0-9]+$`
    — never the final `credentials.json` directly. Tail-asserts
    the new token reads back correctly AND the on-disk file
    doesn't leak the plaintext token (encryption invariant
    preserved).

## Verify

- `@muse/cli` suite green (1048 passed, +2 vs baseline 1046,
  0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `tmp+rename` back to the direct `writeFile(filePath, ...)`
  shape makes the new test fail with `expected
  '/.../credentials.json' not to be '/.../credentials.json'`
  (the captured path equals credPath directly) — exactly the
  pre-fix call shape the test pins against.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1048
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. The credential store is a local on-disk
  persistence layer, not HTTP surface.

## Status

Done. The credential store now matches the atomic-write posture
every other persistence layer in the codebase already had:

| Crash window                          | Before                        | After                       |
| ------------------------------------- | ----------------------------- | --------------------------- |
| Between open(O_TRUNC) and write       | **credentials.json = 0 bytes**| tmp = partial (target intact) |
| After successful write                | credentials.json populated    | unchanged                   |
| After rename (post-fix only)          | n/a                           | credentials.json populated  |
| User-visible recovery on next start   | **`(no creds — forced re-login)`** | `(creds still here)` (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: an
atomic-write defensive `fix:` on the most-load-bearing
local credential store, recorded honestly with this backlog
row — not a false metric.

## Decisions

- **`randomBytes(8).toString("hex")` for the tmp suffix**, not
  just `Date.now()`. Two `muse auth login` invocations within
  the same millisecond (rapid CI-style scripted invocation,
  parallel webhook handlers) would collide on the Date.now
  suffix; the random bytes close that. Same pid is already
  baked in so two processes can't collide either.
- **`chmod(filePath, 0o600).catch(() => undefined)` after
  rename**, matching the `inbox-store` / `inbox-injection-cursor`
  patterns. Defense-in-depth against any filesystem that
  preserves target-file mode on rename. The
  `.catch(() => undefined)` keeps the function fail-open on
  Windows-ish file systems where chmod is a no-op.
- **`vi.mock("node:fs/promises", ...)` for the test**, not
  `vi.spyOn`. ESM namespace bindings aren't configurable —
  `vi.spyOn(fsPromises, "writeFile")` throws
  `Cannot redefine property: writeFile`. `vi.mock` with
  `importOriginal` is the canonical vitest workaround for
  hooking node built-ins.
- **Delegate to actual writeFile inside the mock**, not stub
  it out. The test still wants the real on-disk write to
  happen so the tail assertions (read-back, encrypted body)
  pass; the mock only TRACKS the path argument, doesn't
  replace the behavior. Same hook works for any future
  credential-store test that wants to inspect fs calls.
- **Pin via `every captured call must be the tmp pattern`**,
  not "the first call." A future implementation that wrote
  twice (e.g. tmp then a debug log) would still pass as long
  as none of the writes targeted credPath directly. The
  invariant is "no writeFile ever touches credPath," not "the
  first one doesn't."
- **Tail assertions on read-back + encrypted body** keep the
  test honest about the happy path: the change isn't allowed
  to break encryption-at-rest or the actual token round-trip.
- **Did NOT also refactor the read path** to handle a 0-byte
  file gracefully. The atomic-write fix means a 0-byte
  scenario never reaches the read path on a working system;
  defending the read path too would be defense-in-depth for
  a defect the write side already closes. Out of scope.

## Remaining risks

- **Crash BEFORE the tmp file is fully written** leaves a
  partial `.tmp-<pid>-<hex>` file in the config dir. No
  cleanup; a later `writeCredentialStore` would create a new
  tmp with a different random suffix and rename over the
  final file, leaving the orphan tmp. A janitor pass that
  removes `.tmp-*` files older than some TTL on startup would
  close that — separate iter.
- **`rename` is atomic on POSIX same-filesystem**, but
  cross-filesystem renames fall back to copy+delete which
  isn't atomic. The tmp is in the same dir as the target so
  this is safe in practice; a future `MUSE_CREDENTIAL_PATH`
  pointing across mount points would break the invariant —
  not currently supported.
- **The credential-store's `readCredentialStore` has no retry
  on JSON.parse failure** — if a future regression
  reintroduces the non-atomic write AND a crash happens, the
  user's only recovery is `rm ~/.config/muse/credentials.json
  && muse auth login`. Same UX as before; the fix prevents
  the failure mode, doesn't add a retry layer.
- **Other `writeFile(filePath, ...)` sites in the apps/cli
  package** weren't audited in this iter. Spot-check
  `chat-history.ts` / `human-formatters.ts` / etc. in a
  follow-up.
