# 597 — `MUSE_RATE_LIMIT_CHAT_DISABLED` accepts every standard truthy spelling (closes goal-587 Remaining Risk on the rate-limit-disable flag)

## Why

`apps/api/src/server-routes.ts:buildDefaultChatRateLimiter` was
the last `MUSE_*` boolean env flag in the API surface that
relied on a strict `=== "true"` literal check:

```ts
if (process.env.MUSE_RATE_LIMIT_CHAT_DISABLED === "true") {
  return undefined;
}
```

Operators setting `MUSE_RATE_LIMIT_CHAT_DISABLED=1` or `=on` or
`=yes` (the common admin-friendly spellings the rest of the
codebase honors via `parseBoolean`) saw the rate limiter
silently stay active. The two PHASE-D `MUSE_*_AGENT_TURN` flags
already use `parseBoolean(env.X, false)` (apps/api/src/server.ts:
300-303); this rate-limit flag was the asymmetric outlier on
the same surface.

Goal 587 (the `decideWebSearchPolicy` falsy-spelling fix) listed
this site in its `Remaining risks` section as a deferred sibling:

> `MUSE_RATE_LIMIT_CHAT_DISABLED` in `apps/api/src/server-routes.ts:107`
> also uses literal `=== "true"`. Same convention sweep target.
> Deferred.

This iteration closes it.

Step-8 redirect note: same defect family as the boolean-spelling
sweep on web-search (585/587). Distinct file
(`apps/api/src/server-routes.ts` vs `packages/model` /
`packages/autoconfigure`), distinct env var
(`MUSE_RATE_LIMIT_CHAT_DISABLED` vs `MUSE_WEB_SEARCH`),
distinct surface (the API's request-path rate limiter vs the
model's web-search gate). Treated as a finishing pass on the
convention sweep — closes the deferred-sibling item from goal
587.

## Slice

- `apps/api/src/server-routes.ts`:
  - Imported `parseBoolean` from `@muse/autoconfigure` (already
    a dep of the api package; same import path
    `apps/api/src/server.ts:6` already uses).
  - New exported helper `isChatRateLimitDisabled(raw)` —
    delegates to `parseBoolean(raw, false)`. Returns true when
    the env value is any of the 4 standard truthy spellings
    (`true` / `1` / `yes` / `on`, case-insensitive, trimmed).
    Falls back to `false` (= NOT disabled = rate limiter
    active) on undefined / unrecognised — the fail-safe
    direction for a security-adjacent kill switch.
  - `buildDefaultChatRateLimiter` now calls
    `isChatRateLimitDisabled(process.env.MUSE_RATE_LIMIT_CHAT_DISABLED)`
    instead of the literal `=== "true"` check.
- `apps/api/test/parse-chat-rate-limit-capacity.test.ts`:
  - Imported `isChatRateLimitDisabled` alongside the existing
    `parseChatRateLimitCapacity`.
  - Added one new describe block "isChatRateLimitDisabled" with
    4 tests:
    - undefined → false (default behavior, rate limit active);
    - every standard truthy spelling → true;
    - every standard falsy spelling → false (rate limit active);
    - unrecognised typo → false (fail-safe direction pinned —
      a security-adjacent flag does NOT silently disable on
      garbage input).

## Verify

- `@muse/api` suite green (258 passed, +4 vs baseline 254, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `isChatRateLimitDisabled` to the pre-fix literal `raw ===
  "true"` makes the "every standard truthy spelling" test fail
  because `"1"` / `"yes"` / `"on"` etc. no longer disable
  (returns false instead of true). Fix restored.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended path is the per-IP chat rate-limiter's
  build-on-startup gate.

## Status

Done. The MUSE_RATE_LIMIT_CHAT_DISABLED env flag is now
spelling-symmetric with the rest of the boolean-env convention:

| Env value                                | Before                                | After                                   |
| ---------------------------------------- | ------------------------------------- | --------------------------------------- |
| `MUSE_RATE_LIMIT_CHAT_DISABLED=` unset   | rate limit active                     | unchanged                                |
| `=true` (case-insensitive)               | disabled                              | unchanged                                |
| `=1` / `=yes` / `=on` (case-insens.)     | **ignored** (rate limit stays active) | disabled (**fixed**)                    |
| `=false` / `=0` / `=no` / `=off`         | rate limit active                     | unchanged                                |
| typo / garbage                           | rate limit active                     | unchanged (fail-safe direction pinned)   |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a convention-
sweep `fix:` on a security-adjacent kill switch — recorded
honestly with this backlog row, not a false metric.

## Decisions

- **Exported helper over inline `parseBoolean` call.** Could
  have done a 1-line edit (`if (parseBoolean(env.X, false))`).
  Extracted a named helper because:
  (a) Testability — direct unit assertions on the helper are
      clearer than indirect test-via-buildDefaultChatRateLimiter
      (the latter requires env-var mutation in tests, which is
      flaky across vitest workers).
  (b) Documentation locality — the fail-safe-direction WHY
      comment sits on the helper, not buried in a route
      registrar.
  (c) A future caller (config dashboard, `muse doctor`) that
      wants to surface "is rate limit disabled?" can reuse the
      helper instead of duplicating the parse.
- **`parseBoolean(raw, false)` from autoconfigure, not a local
  copy.** The helper already encodes the 8-spelling set
  (true/1/yes/on truthy, false/0/no/off falsy, fallback on
  unknown). Cross-package import is already present in
  `apps/api/src/server.ts:6` for the same purpose — adding a
  second import site is the conventional move, not a new
  helper.
- **Fail-safe direction on unrecognised input.** The flag is a
  `*_DISABLED` kill switch on a security-adjacent feature (per-
  IP chat rate limiting that protects the LLM upstream quota).
  Falling back to `false` (= NOT disabled = rate limit ON)
  means a typo'd kill switch keeps the protection active. The
  opposite default would silently disable rate limiting on any
  unrecognized input — a serious operational footgun.
- **Test the fail-safe explicitly.** The 4th test pins the
  "unrecognised → not disabled" contract so a future refactor
  that tightens parsing differently (e.g. throw on unknown)
  can't silently flip the fail-safe direction. Same
  defense-in-depth posture as goal 587's typo-resistance test.

## Remaining risks

- **`MUSE_TELEGRAM_POLL_ENABLED === "1"`** in
  `apps/api/src/server.ts:338` — single-spelling literal check
  on the telegram inbox poll daemon. Different polarity
  (`*_ENABLED` = opt-in, with the fail-safe direction being
  "don't enable on typo"). Same convention-sweep target, just
  in a different file. Deferred to keep this iteration tight.
- **`MUSE_MESSAGING_MACOS_NOTIFICATION_ENABLED` /
  `MUSE_MESSAGING_LIBNOTIFY_ENABLED`** in
  `packages/autoconfigure/src/registry-builders/messaging.ts:109,121`
  — same `=== "true"` shape on the desktop-notification
  registry-builder. Deferred (sibling defect, deferred from
  goal 587).
- Goal 595 / 596's finite-guard sweep across in-memory store
  constructors is still incomplete — `memory-auto-extract.ts`
  + `pattern-detector.ts` + `tools/src/index.ts:166` all share
  the `?? default + Math.max` shape. Out of scope for this
  iter.
