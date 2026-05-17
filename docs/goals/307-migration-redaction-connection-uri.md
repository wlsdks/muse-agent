# 307 — migration redactor missed connection URIs with inline passwords

## Why

`redactMigrationText` (`@muse/policy`) sanitises DB-migration
logs/output before they're surfaced or persisted — a
security/secrets boundary (CLAUDE.md: don't leak live
credentials). Its `url` rule is **http-only**
(`/\bhttps?:\/\/[^\s)"'<>]+/`) and the `token` rule covers only
`sk-` / `ghp_` / `xox*` shapes. The single **most common secret
in exactly this context** — a database/cache connection URI with
an inline password
(`postgres://user:secretpw@host/db`, `mysql://…`,
`redis://:authpw@host`, `mongodb://…`, `amqp://…`) — matched
**none** of them and was emitted **in cleartext** in the
"redacted" log. A credential leak in the very output this module
exists to scrub.

## Scope

`packages/policy/src/migration-redaction.ts`:

- Add a `connection` `RedactionKind` and a first-priority pattern
  `\b<scheme>://[user]?:<password>@<rest>` (any scheme; user
  optional so password-only Redis URIs are caught) →
  `[redacted-connection]`. It runs **before** the http `url`
  rule so credentials are stripped first; a credential-free
  `https://host/path` does not match it and still falls through
  to the existing `url` rule (no regression). One short WHY
  comment records the non-http-scheme rationale.

Behaviour-preserving for every prior input: email / token / path
/ private-term / plain-http-url / public-names cases are
unchanged; only credentialed connection URIs — previously a
cleartext leak — are now redacted.

## Verify

- `pnpm --filter @muse/policy test` — 67 pass (was 66; +1). New
  regression: `postgres://muse:secretpw@…` and
  `redis://:authpw@…` are redacted (no `secretpw` / `authpw` in
  the output, `[redacted-connection]` present, finding
  `{count:2, kind:"connection"}`); a credential-free
  `https://internal.example.org/path` still yields
  `[redacted-url]` (existing coverage intact). The existing
  common-material / private-terms / public-names tests stay
  green.
- `pnpm check` — every workspace green (policy 67, apps/cli 563,
  apps/api 161, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (deterministic
  secret-redaction regex). A live Qwen run cannot reproduce a
  connection-string-in-migration-log on demand, so the
  deterministic regression is the rigorous verification — same
  stance as the redaction/security goals 278 / 294 / 298.

## Status

done — DB connection URIs with inline passwords are now redacted
from migration output instead of leaking in cleartext, closing a
credential exposure in the exact logs this guard sanitises.
http/email/token/path/private-term redaction is unchanged.
