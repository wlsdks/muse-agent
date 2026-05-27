# 612 — `captureEndOfSessionEpisode` accepts every standard truthy spelling of `MUSE_EPISODIC_MEMORY_ENABLED` (`1` / `yes` / `on` / `TRUE`), not just the literal `true` string

## Why

`apps/cli/src/chat-end-session.ts` opt-in gate, pre-fix:

```ts
if ((env.MUSE_EPISODIC_MEMORY_ENABLED ?? "").trim().toLowerCase() !== "true") {
  return { reason: "MUSE_EPISODIC_MEMORY_ENABLED is not true", status: "skipped" };
}
```

The check only matches the exact string `"true"`. An operator who
writes the natural `MUSE_EPISODIC_MEMORY_ENABLED=1` in their shell
rc — the same form they'd use for every other Unix-style boolean
env — silently gets episodic memory disabled, with no diagnostic
telling them their `1` wasn't recognised.

The repo already has the canonical `parseBoolean` helper in
`@muse/autoconfigure/env-parsers.ts` that accepts the standard
truthy set `{true, 1, yes, on}` and the falsy set `{false, 0, no,
off}` case-insensitively. Goal 597 swept the same spelling-gap on
`MUSE_RATE_LIMIT_CHAT_DISABLED`; this is the same convention
applied to the episodic-memory gate.

Step-8 redirect: 597 is 15 commits back (outside the recent-10
window: 611, 610, 609, 608, 607, 606, 605, 604, 603, 602). The
recent classes are validation-gate (610/611), finite-clamp (609),
precision (608), state observability (607), BOM (606), dedup
(605), memory-cap (604), CLI empty-id (603), Invalid-Date (602),
regex-coverage (601). Boolean-spelling parity isn't in the recent
window — safe direction.

## Slice

- `apps/cli/src/chat-end-session.ts`:
  - Added `parseBoolean` to the existing `@muse/autoconfigure`
    import (was just `resolveEpisodesFile`).
  - Replaced the `=== "true"` literal compare with
    `!parseBoolean(env.MUSE_EPISODIC_MEMORY_ENABLED, false)`.
    Default stays `false`: unset / unknown spelling = fail-
    safe, episodic memory does NOT run.
  - Updated the skip reason from `"is not true"` to `"is not
    enabled (set to true/1/yes/on to opt in)"`. The reason
    text now tells the operator the accepted spellings —
    actionable instead of cryptic. Existing telemetry greps
    that string-contain `"MUSE_EPISODIC_MEMORY_ENABLED"` still
    match (the var name is preserved).
- `apps/cli/test/program.test.ts`:
  - One new test in the existing `captureEndOfSessionEpisode`
    block. Loops over `["1", "yes", "on", "TRUE", "True"]` and
    asserts each enables the gate (captures an episode end-to-
    end). Also asserts unknown spellings (`"maybe"`, `"perhaps"`,
    `""`) still fail-safe to `{ status: "skipped" }` with a
    reason that names the env var.

## Verify

- `@muse/cli` suite green (1042 passed, +1 vs baseline 1041, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to the
  literal-true compare makes the new test fail with `expected
  the captureEndOfSessionEpisode gate to accept
  MUSE_EPISODIC_MEMORY_ENABLED="1", got
  {"reason":"MUSE_EPISODIC_MEMORY_ENABLED is not true",
  "status":"skipped"}` — exactly the operator-confusion symptom
  documented above.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1042
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. The episodic-memory gate is a CLI shutdown path,
  not HTTP surface — the inner `summariseSession` call uses
  the model, but that path is unchanged.

## Status

Done. The episodic-memory env gate now follows the same
spelling-convention every other `MUSE_*_ENABLED` flag uses:

| Env value          | Before                  | After                       |
| ------------------ | ----------------------- | --------------------------- |
| unset              | skipped (fail-safe)     | unchanged                   |
| `true`             | enabled                 | unchanged                   |
| `TRUE` / `True`    | **skipped** (case-sens) | enabled (**fixed**)         |
| `1`                | **skipped**             | enabled (**fixed**)         |
| `yes`              | **skipped**             | enabled (**fixed**)         |
| `on`               | **skipped**             | enabled (**fixed**)         |
| `maybe` / `foo`    | skipped (fail-safe)     | unchanged                   |
| `false` / `0` / `no` / `off` | skipped (fail-safe) | unchanged                |
| `""` (empty)       | skipped (fail-safe)     | unchanged                   |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a UX
consistency `fix:` on the episodic-memory opt-in gate, recorded
honestly with this backlog row — not a false metric.

## Decisions

- **Use the shared `parseBoolean` from `@muse/autoconfigure`,
  don't inline a new spelling set.** The package already exports
  the canonical helper used by every other boolean-spelling
  consumer (`MUSE_VETO_AVOIDANCE`, `MUSE_RATE_LIMIT_CHAT_DISABLED`,
  the web-search policy decision, etc.). Inlining would create
  drift; a future tightening of the truthy set (e.g. adding
  `enabled` as an alias) would have to be re-done at every
  inline site.
- **`parseBoolean(..., false)` — fail-safe default.** Episodic
  memory writes to disk and round-trips the user's chat into
  the LLM at boot; the opt-in posture should be "off by
  default, on only when explicitly enabled." An unset or
  unknown env value defaults to OFF, matching the pre-fix
  behavior for the unset case.
- **Updated the skip reason** to name the accepted spellings.
  The pre-fix `"is not true"` was technically accurate but
  surprising to an operator who set `=1` and saw their feature
  off; the new text actively points at the fix.
- **Test reuses the existing `cli program` describe.** The
  block already contains the happy-path and scrub-path tests
  for `captureEndOfSessionEpisode`; the spelling-acceptance
  case is the natural neighbor. Restoring the env vars in the
  `finally` block mirrors the existing pattern there.
- **Mutation choice.** Reverted to the exact pre-fix three
  lines (the literal-true compare + the old "is not true"
  reason). The mutation reproduces the pre-fix shape — the
  realistic regression a maintainer might write while
  "simplifying back to a one-line === compare."
- **Did NOT also forward `parseBoolean` to other adjacent
  env-reads in `chat-end-session.ts`** — there aren't any.
  Scope-limited to the one site.

## Remaining risks

- **Other `MUSE_*_ENABLED` flags** in the wider codebase
  haven't been audited in this iter. Goal 597 hit one site
  (rate-limit); this iter hit one site (episodic). A full
  sweep would be a separate iteration (and Step-8 redirect
  away from boolean-spelling for a few iters first).
- **`parseBoolean`'s acceptance set** is hard-coded in
  `@muse/autoconfigure/env-parsers.ts`. A future
  `=enabled` / `=active` spelling would need to be added
  there; consumers would benefit automatically.
- **Documentation drift** — anywhere the docs say
  "MUSE_EPISODIC_MEMORY_ENABLED=true" should ideally also
  mention the alias spellings now accepted. Doc audit is
  a separate, lower-priority iter.
