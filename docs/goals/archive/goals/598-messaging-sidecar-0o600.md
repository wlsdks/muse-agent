# 598 — Telegram / Discord / Slack inbound-cursor sidecars persisted with mode 0o600 (aligns with `inbound-thread-store` + credential-store conventions)

## Why

Three messaging sidecar files persist per-channel polling cursors:

- `packages/messaging/src/telegram-offset-store.ts` — Telegram
  `update_id` offset for the bot's `getUpdates` poll.
- `packages/messaging/src/discord-after-store.ts` — per-channel
  `after=<snowflake>` cursor for Discord channel polls.
- `packages/messaging/src/slack-after-store.ts` — per-channel `ts`
  cursor for Slack `conversations.history` polls.

The pre-fix `writeXAfter` / `writeTelegramOffset` calls all
landed at the same shape:

```ts
await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
await fs.rename(tmp, file);
```

`fs.writeFile` with only the encoding option defers the file
mode to the operating system's umask — typically `0o644` on
Linux/macOS, leaving these files **world-readable on a shared
box**.

Each of these sidecars reveals:
- Telegram: which bot updates the user has acknowledged (the
  polling cadence + the offset signals presence + activity).
- Discord: every channel id the bot polls + the last snowflake.
- Slack: every channel id the bot polls + the last `ts` cursor.

The list of channels + snowflakes / cursors is **private user
data** — it answers "which Discord servers / Slack workspaces
does this user's Muse bot listen on, and when did it last hear
something?" — exactly the surveillance signal a multi-tenant
unix box would expose to other users.

The sibling stores already use `mode: 0o600`:

- `packages/messaging/src/inbound-thread-store.ts:77` —
  `fs.writeFile(tmp, ..., { mode: 0o600 })`. Its docstring
  calls out the convention: "Atomic tmp+rename, 0o600, like
  the sibling stores."
- `packages/messaging/src/credential-store.ts:86` —
  `{ encoding: "utf8", mode: 0o600 }` plus an explicit chmod
  after rename for double-defense.

These three stores were the asymmetric outliers — the docstring
called the 0o600 convention out as "like the sibling stores,"
but the siblings themselves weren't following it.

Step-8 redirect note: distinct from the recent finite-guard
sweep (595/596) and the boolean-spelling sweep (585/587/597).
Defect class is "file-mode convention not enforced on private
user-data sidecars" — a small but visible polish, security-
adjacent, defensible without provider-specific knowledge.

## Slice

Three identical one-line edits, each adding `{ encoding: "utf8",
mode: 0o600 }` to the `fs.writeFile` call, plus a short WHY
comment explaining the surveillance threat:

- `packages/messaging/src/telegram-offset-store.ts:54`.
- `packages/messaging/src/discord-after-store.ts:44`.
- `packages/messaging/src/slack-after-store.ts:41`.

Test additions in `packages/messaging/test/messaging.test.ts` —
three new tests, one per store, each asserting
`statSync(file).mode & 0o777 === 0o600` after a write. Mirrors
the existing `inbound-thread-store.test.ts:104` test that pins
the same contract on its sibling.

## Verify

- `@muse/messaging` suite green (176 passed, +3 vs baseline 173,
  0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `writeTelegramOffset` writeFile back to just `"utf8"` makes
  the new `telegram-offset-store` mode test fail — the file
  is created with the default umask mode (`0o644` on Linux
  containers, often `0o600` on macOS development boxes due to
  umask 077, so the mutation might or might not surface
  depending on the host umask, but the test pins the explicit
  `0o600` invariant). Confirmed the test fails on the dev box
  here. Fix restored.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the four intended
  files (3 source + 1 test).
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended path is on-disk file permissions for messaging
  cursor sidecars.

## Status

Done. The three messaging cursor sidecars now match the
`inbound-thread-store` + credential-store posture:

| File                                                                     | Before                    | After                           |
| ------------------------------------------------------------------------ | ------------------------- | ------------------------------- |
| `~/.muse/telegram-offset.json` (via `writeTelegramOffset`)               | umask default (typ. 0644) | 0600 (**fixed**)                |
| `~/.muse/discord-after.json` (via `writeDiscordAfter`)                   | umask default (typ. 0644) | 0600 (**fixed**)                |
| `~/.muse/slack-after.json` (via `writeSlackAfter`)                       | umask default (typ. 0644) | 0600 (**fixed**)                |
| `~/.muse/inbound-thread-store.json` (via `appendThreadTurns`)            | 0600 (unchanged)          | unchanged                       |
| `~/.muse/messaging-credentials.json` (via `FileMessagingCredentialStore`) | 0600 (unchanged)          | unchanged                       |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a security-
hardening / convention-sweep `fix:` on the messaging sidecar
file modes, recorded honestly with this backlog row — not a
false metric.

## Decisions

- **Mode-on-create only, no post-rename chmod.** The
  `FileMessagingCredentialStore` does BOTH `mode: 0o600` on
  writeFile AND `fs.chmod(this.file, 0o600).catch(...)` after
  rename. The post-rename chmod is defense-in-depth against
  filesystems where rename preserves the target's old mode.
  Skipped here because:
  (a) The `inbound-thread-store` precedent uses mode-on-create
      only (no post-rename chmod) and its docstring is the
      explicit convention reference.
  (b) Linux / macOS rename replaces the target's inode, so
      the new file has the tmp's mode — `mode: 0o600` on the
      tmp suffices in practice.
  (c) Adding chmod requires an additional catch for ENOENT
      between rename and chmod (race window if the file is
      removed by another process between the two syscalls);
      not worth the complexity for one extra layer when the
      tmp's mode already wins.
- **Three identical edits in one commit.** This is a tight
  convention sweep — same one-line change in three sibling
  files with the same defect. Treating them as separate
  iterations would split a coherent move across days. The
  goal-588 calendar create/update symmetry precedent fixes
  two sibling fields in one commit (`applyOptionalString` +
  `applyOptionalArray`); same posture here.
- **One test per store, not a single shared test.** Could
  have written one helper test that loops over the three
  stores. Per-store tests keep the failure messages
  attributable to a specific file when a future regression
  arrives — same posture as the inbound-thread-store's
  per-file mode test.
- **WHY comments at each call site.** The mode argument is
  the WHY (security / multi-user-box threat model), not WHAT
  (which the code already says). A reader who removes the
  mode option needs to understand they're un-doing a
  defense, not making a trivial cleanup.

## Remaining risks

- **`packages/messaging/src/inbox-store.ts`** has its own
  `fs.writeFile` call — would need a separate check that it's
  on the same convention. Deferred to keep this iteration
  scoped to the three after-store siblings flagged by the
  inbound-thread-store docstring.
- **Post-rename chmod for defense-in-depth** could be added
  uniformly across all 4+ stores in a follow-up, matching
  the credential-store posture. Out of scope here — the
  on-create mode is the load-bearing fix.
- Windows: `mode: 0o600` is effectively a no-op (Windows
  doesn't honor POSIX modes the same way). The tests use
  `statSync().mode & 0o777` which on Windows returns
  filesystem-defaults that may not equal `0o600`. CI runs on
  Linux/macOS so the tests pin the contract there.
