# 312 — Slack send didn't escape &/</> (silent message corruption, stray @channel) — 311 sibling

## Why

`SlackProvider.send` posts the agent's text via
`chat.postMessage` with only the `text` field. Slack **always**
renders `text` as mrkdwn, where `&`, `<`, `>` are control
characters. `send` passed `outboundText` **raw**, so when a
reminder / notice / answer contained them:

- `<https://…>` / `<@U123>` substrings → Slack parses them as
  auto-links / mentions and they vanish from the displayed text;
- a literal `<!channel>` / `<!here>` in the agent's text →
  Slack broadcast-pings the **entire channel** (a real,
  unintended noise/safety problem for a proactive assistant);
- `&` → mojibake.

Unlike Telegram (goal 311, hard 400), Slack **fails silently** —
the message is delivered but corrupted/transformed — which is
arguably worse: no error, no retry, the user just gets the wrong
message (or the whole channel gets pinged). Slack's documented
rule is to escape exactly `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`.

## Scope

`packages/messaging/src/slack-provider.ts`:

- Add `escapeSlackText(text)`: `&`→`&amp;` first (so `&lt;`
  isn't double-escaped), then `<`→`&lt;`, `>`→`&gt;`. Apply to
  the `text` in `send`, after clamp + validate (consistent with
  the Telegram path; the few entities don't meaningfully change
  length). One short WHY comment records the
  mrkdwn-control-char / `<!channel>` rationale. Re-exported from
  the messaging barrel for direct coverage. No `parseMode`
  branch — Slack always interprets `text` as mrkdwn, so the
  escape is unconditional (tighter than Telegram).

Behaviour-preserving: text without `&<>` (incl. plain `*bold*`
mrkdwn, which stays literal) is byte-identical, so the existing
`text:"hi"` / truncate send tests stay green.

## Verify

- `pnpm --filter @muse/messaging test` — 126 pass (was 124;
  +2). New: sending
  `"see <!channel> & docs at <https://x> when x < y"` puts
  `"see &lt;!channel&gt; &amp; docs at &lt;https://x&gt; when x &lt; y"`
  on the wire (pre-fix: a channel-wide ping + an eaten link).
  Direct `escapeSlackText` unit test pins the three-char rule,
  ampersand-first ordering, and that mrkdwn formatting chars are
  left literal. The existing ok:true / ok:false / truncate /
  inbound Slack tests stay green.
- `pnpm check` — every workspace green (messaging 126,
  apps/cli 563, apps/api 161, all packages). `pnpm lint` —
  exit 0.
- No real-LLM request/response path touched (outbound Slack API
  text escaping). A live Qwen run cannot exercise Slack's mrkdwn
  renderer, and a real Slack round-trip needs workspace
  credentials the project must not commit, so the deterministic
  fake-fetch regression is the rigorous verification — same
  stance as goal 311.

## Status

done — Slack outbound text is now escaped per Slack's mrkdwn
rule, so a `<…>` or `&` in a notice can no longer silently
corrupt the message or broadcast-ping the channel. Plain text
(no `&<>`) is unchanged. The "set/assume a markup mode but don't
escape" class is now closed for both Telegram (311) and Slack
(312).
