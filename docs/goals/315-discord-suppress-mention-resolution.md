# 315 — Discord send had no allowed_mentions: a literal @everyone pinged the whole server

## Why

`DiscordProvider.send` posts the agent's text as
`{ content: outboundText }` with **no `allowed_mentions`**.
Discord's default behaviour with an absent `allowed_mentions` is
to **parse and resolve every mention in `content`** — so a
literal `@everyone` / `@here` / `<@userId>` / `<@&roleId>` in a
reminder / proactive notice / answer (a quote of the user, a
code snippet, an example) **pings the entire server / the
mentioned member**. For a personal JARVIS relaying arbitrary
text into a Discord channel this is a real noise + safety
problem, the Discord analog of the Slack `<!channel>` broadcast
risk fixed in goal 312, and a sibling of the Telegram/Slack
outbound-safety work (311 / 312).

## Scope

`packages/messaging/src/discord-provider.ts` — `send`:

- Add `allowed_mentions: { parse: [] }` to the message body.
  `parse: []` is Discord's documented directive for relay bots:
  resolve **no** mention types. The text still displays
  verbatim (`@everyone` shows as the literal string); it simply
  no longer notifies. One short WHY comment records the
  empty-parse-array semantics (non-obvious).

Behaviour-preserving for the delivered content (verbatim, same
2000-char clamp + validate); the only change is that mentions in
that content no longer trigger pings — the safe default for an
assistant that delivers its own user's notices. (Targeted pings,
if ever needed, would be an explicit future opt-in.)

## Verify

- `pnpm --filter @muse/messaging test` — 127 pass (was 126;
  +1). New: sending
  `"reminder: ping @everyone and <@123> about it"` puts that
  string **verbatim** in `content` (not stripped) **and**
  `allowed_mentions: { parse: [] }` on the wire (pre-fix: no
  `allowed_mentions` → Discord pings @everyone + member 123).
  The existing Bot-auth / URL / 2000-char-truncate Discord send
  tests stay green (the new field is additive; they assert only
  `content` / url / auth).
- `pnpm check` — every workspace green (messaging 127,
  apps/cli 563, apps/api 161, all packages). `pnpm lint` —
  exit 0.
- No real-LLM request/response path touched (outbound Discord
  API request shape). A live Qwen run cannot exercise Discord's
  mention resolver, and a real Discord round-trip needs a bot
  token the project must not commit, so the deterministic
  fake-fetch regression is the rigorous verification — same
  stance as goals 311 / 312.

## Status

done — Discord outbound messages now suppress all mention
resolution, so a literal `@everyone` / `@here` / user-or-role
mention in any agent output can no longer ping the server while
the text still shows verbatim. Delivered content is unchanged.
The outbound-channel mention/markup-safety class is now closed
for Telegram (311), Slack (312), and Discord (315).
