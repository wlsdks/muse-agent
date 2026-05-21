# 622 — close the four daemon-enable flags in `apps/api/src/server.ts` on goal 612's boolean-spelling convention — `MUSE_TELEGRAM_POLL_ENABLED` / `MUSE_INBOUND_REPLY_ENABLED` / `MUSE_SLACK_POLL_ENABLED` / `MUSE_DISCORD_POLL_ENABLED` now accept every standard truthy spelling, not just the literal `1`

## Why

Goal 612 fixed `MUSE_EPISODIC_MEMORY_ENABLED` — the gate had been
checking `=== "true"` literal, so an operator setting `=1` got
the feature silently disabled. The codebase has a shared
convention via `parseBoolean(env, false)` in `@muse/autoconfigure`
that accepts the canonical truthy set `{true, 1, yes, on}` and
falsy set `{false, 0, no, off}` case-insensitively. Goal 597
established the pattern, goal 612 carried it to the episodic-memory
gate.

`apps/api/src/server.ts` still carries four sibling sites with
the same defect — each literal `=== "1"` compare:

| Site (line)                  | Env var                          |
| ---------------------------- | -------------------------------- |
| 338                          | `MUSE_TELEGRAM_POLL_ENABLED`     |
| 372                          | `MUSE_INBOUND_REPLY_ENABLED`     |
| 423                          | `MUSE_SLACK_POLL_ENABLED`        |
| 456                          | `MUSE_DISCORD_POLL_ENABLED`      |

Each daemon (Telegram poller, inbound-reply orchestrator, Slack
poller, Discord poller) is gated by the matching env. An operator
who writes the natural Unix-style `MUSE_TELEGRAM_POLL_ENABLED=true`
in their shell rc — the same form every other Muse env flag
accepts — silently gets the Telegram daemon off, with no diagnostic.
Identical UX hazard on the other three.

Same defect family as goal 612 (boolean spelling). Goal 612 is
10 commits back — just at the edge of the Step-8 last-10 window
but only one prior occurrence of the family. Safe to apply the
canonical pattern here.

## Slice

- `apps/api/src/server.ts`:
  - New exported helper at the bottom of the file:
    ```ts
    export function isMuseDaemonEnabled(envValue: string | undefined): boolean {
      return parseBoolean(envValue, false);
    }
    ```
    Single-purpose wrapper exists for two reasons: (1) it gives
    the four call sites a self-documenting name (the call reads
    `isMuseDaemonEnabled(...)` instead of `parseBoolean(..., false)`,
    making the daemon-gate intent obvious), and (2) it provides a
    single mutation-testable surface — a regression that reverts
    to `=== "1"` lands in one place.
  - The four daemon-gate lines now call the helper:
    ```ts
    const pollEnabled = isMuseDaemonEnabled(process.env.MUSE_TELEGRAM_POLL_ENABLED);
    const inboundReplyEnabled = isMuseDaemonEnabled(process.env.MUSE_INBOUND_REPLY_ENABLED);
    const slackPollEnabled = isMuseDaemonEnabled(process.env.MUSE_SLACK_POLL_ENABLED);
    const discordPollEnabled = isMuseDaemonEnabled(process.env.MUSE_DISCORD_POLL_ENABLED);
    ```
  - `parseBoolean` is already imported (goal 597 wired it for
    the rate-limit-disabled gate; goal 612 used it for episodic
    memory). No new import needed.
- `apps/api/test/is-muse-daemon-enabled.test.ts`:
  - New focused test file with three assertions:
    - Every canonical truthy spelling (`1`, `true`, `True`, `TRUE`,
      `yes`, `YES`, `Yes`, `on`, `ON`, `On`) → `true`.
    - Every canonical falsy spelling (`0`, `false`, `False`, etc.)
      → `false`.
    - Fail-safe defaults: `undefined`, `""`, `"   "`, `"maybe"`,
      `"perhaps"`, `"?"` all → `false`.

## Verify

- `@muse/api` suite green (261 passed, +3 vs baseline 258, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the helper
  body back to `(envValue ?? "").trim() === "1"` makes the
  canonical-truthy test fail with `expected truthy spelling
  "true" to enable: expected false to be true` — exactly the
  pre-fix operator-confusion symptom on the very next spelling
  past `1`.
- `pnpm check` EXIT=0 (apps/api 261 passed, apps/cli 1052
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. The four gates are env-only daemon start
  conditions — verified by `pnpm check`'s integration coverage
  of `buildServer`.

## Status

Done. The boolean-spelling convention is now uniform across
every `MUSE_*_ENABLED` flag the API surface uses:

| Env var                              | Before                | After                       |
| ------------------------------------ | --------------------- | --------------------------- |
| `MUSE_RATE_LIMIT_CHAT_DISABLED`      | `parseBoolean` (597)  | unchanged                   |
| `MUSE_EPISODIC_MEMORY_ENABLED`       | `parseBoolean` (612)  | unchanged                   |
| **`MUSE_TELEGRAM_POLL_ENABLED`**     | **literal `=== "1"`** | `parseBoolean` (**fixed**)  |
| **`MUSE_INBOUND_REPLY_ENABLED`**     | **literal `=== "1"`** | `parseBoolean` (**fixed**)  |
| **`MUSE_SLACK_POLL_ENABLED`**        | **literal `=== "1"`** | `parseBoolean` (**fixed**)  |
| **`MUSE_DISCORD_POLL_ENABLED`**      | **literal `=== "1"`** | `parseBoolean` (**fixed**)  |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a UX consistency
finishing-pass `fix:` on the four remaining daemon-enable flags
in the api surface, recorded honestly with this backlog row —
not a false metric.

## Decisions

- **Single shared helper, not four separate inlined
  `parseBoolean(...)` calls.** The helper gives the call site a
  self-documenting name and provides a single mutation-testable
  surface. A future regression that breaks the convention lands
  in one place rather than four.
- **Exported helper, not module-private.** Other api-package
  files (`tick-daemons.ts`, future poll-tick wiring) can reuse
  the same gate without re-duplicating the pattern. The export
  also makes the test importable.
- **No bare `parseBoolean(env, false)` at call sites.** Using
  the named helper (`isMuseDaemonEnabled(env)`) instead of the
  generic wrapper documents the intent — "this is a daemon-
  enable flag, accept the standard set, default-off."
- **Test the helper directly, not buildServer's daemon-start
  paths.** A buildServer-level test would have to construct
  full `ServerOptions` (messaging registry, inbox files, agent
  runtime, etc.) for each of the 4 daemons just to assert
  "env=true activates." The helper-level test is the load-
  bearing surface — every site now routes through it.
- **Three test groups (truthy / falsy / fail-safe).** Splitting
  the contract three ways means a regression report localizes
  to the specific axis that broke. A combined "accepts X /
  rejects Y" test would obscure that.
- **Mutation choice.** Reverted the helper body back to the
  exact pre-fix shape `(envValue ?? "").trim() === "1"`. That's
  the realistic regression a maintainer might write while
  "simplifying back to the original literal compare." The
  mutation test catches it on the very next spelling past `1`
  (the literal `"true"`).
- **No source comment naming "goal 622".** Comment policy
  says no goal markers in source — the helper's role is
  self-evident from its name and the existing parseBoolean
  contract; the goal context lives here in the doc.

## Remaining risks

- **Other `MUSE_*_ENABLED` flags** in the wider codebase
  weren't audited in this iter. Spot-checks would target any
  remaining literal-only checks across packages; closed sites
  through this iter:
    - apps/api/src/server.ts (4 daemon-enable flags) — done
    - apps/cli/src/chat-end-session.ts (`MUSE_EPISODIC_MEMORY_ENABLED`) — goal 612
    - apps/api/src/server-routes.ts (`MUSE_RATE_LIMIT_CHAT_DISABLED`) — goal 597
- **The interval-clamp env vars** (`MUSE_TELEGRAM_POLL_INTERVAL_MS`
  etc.) are still parsed via raw `Number(...)` with no `parseBoolean`
  family — they're integer flags, different defect family, not
  in scope here.
- **`parseBoolean` itself**'s acceptance set is hard-coded
  in `@muse/autoconfigure/env-parsers.ts`. A future
  `=enabled` / `=active` spelling would need to be added there;
  the four sites here would automatically pick it up.
- **Documentation drift** — README / runbook references to
  `MUSE_TELEGRAM_POLL_ENABLED=1` could be updated to
  `=true` / `=yes` to encourage the more readable form. Doc
  audit is a separate, lower-priority iter.
