# 423 — Redact Telegram & Discord bot tokens (Muse's own channels)

## Why

Security fix on a maximally high-leverage, fresh axis:
`@muse/shared` `redactSecretsInText` is the credential scrubber
run pre-delivery on proactive notices / history / logs so a
secret that landed in a task title or error body doesn't
"round-trip back via Telegram / Slack" (its own stated threat
model). Used by every package.

The pattern list covered OpenAI / Anthropic / GitHub / AWS /
Google / Slack / Stripe / GitLab / JWT / connection-URIs — but
**not Telegram or Discord bot tokens**, which are Muse's *own*
delivery channels (`telegram-provider.ts`, `discord-provider.ts`;
Telegram is the loop's mandated channel). A bot token leaking
into a notice is the worst case in the docstring's own model: it
round-trips out via the very bot it controls, handing channel
control to anyone who reads that message/log. Probed (built
dist):

```
"<10-digit botId>:<35 base64url chars>"  (Telegram)  → *** LEAKED ***
"<24>.<6>.<38> base64url segments"       (Discord)   → *** LEAKED ***
"sk-ant-api03-…" (sanity)                            → REDACTED
```

## Slice

- `packages/shared/src/index.ts` — two patterns appended to
  `SECRET_PATTERNS` (after `jwt` so real JWTs are rewritten
  first and can't collide):
  - `telegram-bot-token` `\b\d{6,}:[A-Za-z0-9_-]{35}\b` — bot id
    (6+ digits), `:`, exactly 35 base64url chars. The fixed-35
    tail makes it distinctive — an ordinary `123456: word`
    cannot match.
  - `discord-bot-token`
    `\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,8}\.[A-Za-z0-9_-]{27,}\b`
    — the non-`eyJ` triple-segment shape (the `jwt` rule, earlier
    in the list, has already redacted genuine JWTs to a
    dot-free marker, so this only sees real Discord tokens).
- `packages/shared/test/shared.test.ts` — assertions in the
  existing redact test: a Telegram token → exact
  `[redacted-telegram-bot-token]`; a Discord token →
  `[redacted-discord-bot-token]`; `"ticket 123456: shipped
  today"` stays untouched (no false positive). Dropped the
  `(goal 086)` marker from the edited test title.

## Verify

- `@muse/shared` full suite 11/11; the existing JWT / OpenAI /
  Slack / connection-URI / plain-English assertions all still
  pass (ordering + no-collision confirmed); tsc strict (shared)
  clean. New assertions fail on the pre-fix code.
- `pnpm check` EXIT=0 — all 26 workspace suites green (api 194,
  cli 731, …): the new universally-applied regexes over-redact
  **nothing** across the whole monorepo's fixtures, empirically
  confirming the low false-positive design. `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean.
- Pure deterministic regex scrubber verified with fixtures; not a
  model request/response path — no `smoke:live` applies.

## Status

Done. A Telegram or Discord bot token that accidentally lands in
a task title / error / notice is now scrubbed before delivery,
closing the most dangerous instance of the scrubber's own threat
model — a channel-control credential exfiltrating through the
channel it controls.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a security hardening of an existing shared
primitive, recorded honestly as a `fix(shared):` change with this
backlog row — not a false metric.

## Decisions

- Scoped to Telegram + Discord (the two of Muse's four channels
  not already covered — Slack is `xox[abprs]-`; LINE channel
  tokens are long opaque base64 with no distinctive shape, so
  redacting them would risk false positives — deliberately left
  out, not gold-plated).
- Placed after `jwt`: a Discord token is structurally
  "three base64url segments" like a JWT; running `jwt` first
  (it requires the `eyJ` header and rewrites to a dot-free
  marker) guarantees the Discord rule only matches genuine
  non-JWT tokens — same "specific-before-generic ordering"
  discipline already documented for the sk-/sk-ant- pair.
