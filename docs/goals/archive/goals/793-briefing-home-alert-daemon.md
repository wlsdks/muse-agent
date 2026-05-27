# 793 — feat: wire home alerts into the briefing daemon (791 reaches production)

## Why

791 added the home-alert line to the briefing + the `homeAlert`
resolver option, but nothing built it from config — so a real user's
running server never surfaced "front door unlocked" in the brief. This
is the production wiring that makes 791 reachable, mirroring the
weather / inbox / related-knowledge daemon options.

## Slice

- `@muse/mcp` smart-home.ts — `parseHomeAlertChecks(raw)` parses a JSON
  array of `{ entityId, label, alertStates }` checks from config;
  fail-open (malformed JSON / non-array / an entry missing fields or
  with no string `alertStates` is dropped).
- `apps/api` tick-daemons.ts — `startSituationalBriefingDaemonIfConfigured`
  builds `homeAlert: () => resolveHomeAlertLine({ baseUrl, token },
  checks)` when HA creds (`MUSE_HOMEASSISTANT_URL` + `_TOKEN`) AND a
  non-empty `MUSE_BRIEFING_HOME_ALERTS` config are present, and passes
  it through the briefing tick.

## Verify

- `@muse/mcp` home-alert-config.test.ts (new, 3): `parseHomeAlertChecks`
  parses valid checks and drops invalid / non-array / malformed /
  empty-alertStates entries, and filters non-string `alertStates`
  members (dropping a check left with none); **end-to-end** — the EXACT
  daemon composition (`parseHomeAlertChecks` → `resolveHomeAlertLine`
  over a contract-faithful HA fake) delivers a `Home: Front door is
  unlocked` line through `runDueSituationalBriefing` + a real
  `MessagingProviderRegistry`.
- **Mutation-proven**: removing the empty-`alertStates` drop guard →
  invalid entries leak → the parse tests fail; restore → 3/3. Full
  `pnpm check` EXIT 0, `pnpm lint` 0/0, `pnpm smoke:broad` 51/0 (server
  boots with the briefing daemon's home-alert wiring). No LLM path →
  no `smoke:live`.

## Decisions

- **Gated on HA creds + a non-empty checks config** — absent either,
  no `homeAlert` is bound and the brief is unchanged; the home line
  only appears when the user opted in by configuring both.
- **Parser in `@muse/mcp`** (mirrors `homeWatchesFromConfig`) so the
  config contract is unit-testable and the daemon stays thin wiring.
- No bullet flip — completes 791 (P20/P8 proactive briefing) into
  production reachability. CAPABILITIES line under P20.
