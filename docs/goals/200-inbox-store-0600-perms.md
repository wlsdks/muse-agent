# 200 — inbox store persists message bodies with 0600 perms

## Why

Every personal-data store in the repo writes its file with
`{ encoding: "utf8", mode: 0o600 }` + a follow-up
`fs.chmod(file, 0o600)` so other unix users on a shared box
can't read it — personal-tasks / reminders / episodes /
persona (goal 198) / calendar credentials (goal 199), and the
calendar store's own comment spells out the rationale.

`inbox-store.ts`'s `appendInbound` was the outlier:

```ts
await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await fs.rename(tmp, file);
```

No `mode`, no `chmod` — so `~/.muse/line-inbox.json` is
created with the process umask (commonly `0644`:
world/group-readable). That file holds **inbound message
bodies** from Telegram / Slack / Discord / Line — at least as
sensitive as a task title (a forwarded OTP, "remind me my
bank PIN is …", private message text). On any multi-user host
every local account could read the user's incoming messages.

The sibling cursor stores (`slack-after-store`,
`telegram-offset-store`) also omit the mode, but they persist
only an opaque Slack timestamp / Telegram update offset — no
message payload — so they're intentionally left out of scope;
the 0600 convention tracks *user data*, and the inbox is the
one that carries it.

## Scope

- `packages/messaging/src/inbox-store.ts`: `appendInbound`
  writes the tmp file with `{ encoding: "utf8", mode: 0o600 }`
  and `await fs.chmod(file, 0o600).catch(() => undefined)`
  after the atomic rename — byte-identical to the posture
  personal-tasks-store / persona-store / calendar
  credential-store already use. No behavior change beyond file
  permissions.
- `packages/messaging/test/messaging.test.ts`: new case —
  after one append and after a second (rewrite) append,
  `statSync(file).mode & 0o777 === 0o600`.

## Verify

- `pnpm --filter @muse/messaging test` — 110 pass (1 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Deterministic file store — no model invoked, no smoke:live
  needed.

## Status

done — inbound message bodies are no longer world/group
readable on a shared machine; the inbox store now matches the
0600 posture of every other user-data store in the repo.
