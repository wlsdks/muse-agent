# 547 — `lastChatHistoryPath` + `activityLogPath` fall through `homedir()` when `HOME=""` (goal-495/505/539/540 sibling on the chat-history + activity-log path resolvers)

## Why

`apps/cli/src/chat-history.ts:52-60` had two path resolvers
sharing the same pre-fix lenient pattern:

```ts
export function lastChatHistoryPath(): string {
  const home = process.env.HOME ?? "~";
  return path.join(home, ".muse", "last-chat.jsonl");
}

export function activityLogPath(): string {
  const home = process.env.HOME ?? "~";
  return path.join(home, ".muse", "activity.jsonl");
}
```

Two concrete defects when `HOME=""` (pre-cleared launcher
pattern):

- `"" ?? "~"` → `""` (?? doesn't catch empty)
- `path.join("", ".muse", "last-chat.jsonl")` →
  `".muse/last-chat.jsonl"` (relative path under CWD)

The chat REPL and the activity-log writer then silently
write under whatever directory the user happened to invoke
`muse` from. Worse: `HOME=undefined` produces a literal
`"~"` directory (path.join does not expand tildes).

Same empty-env-shadow / `?.HOME ??` defect class as goals
495 (`defaultCredentialPath`), 505 (`defaultConfigPath`),
539 (`approvalsPath`/`trustPath`), 540 (`jobsDir`/
`MUSE_NOTES_DIR`). Two more outliers closed.

## Slice

- `apps/cli/src/chat-history.ts` — added `homedir` import
  from `node:os`; extracted a tiny private `resolveHome()`
  helper that mirrors the goal-505 `defaultConfigPath`
  body byte-for-byte:
  ```ts
  function resolveHome(): string {
    const envHome = process.env.HOME?.trim();
    if (envHome && envHome.length > 0) return envHome;
    const sysHome = homedir().trim();
    if (sysHome.length > 0) return sysHome;
    throw new Error("Cannot resolve home directory — HOME is empty and os.homedir() returned no value");
  }
  ```
  Both `lastChatHistoryPath` and `activityLogPath` now call
  `path.join(resolveHome(), ".muse", ...)`. Behaviour
  byte-identical for every clean HOME value; only the
  empty / whitespace-only HOME path falls through to
  `homedir()` (or throws if both are empty).
- `apps/cli/src/chat-history.test.ts` — added one new
  `describe(...)` block with 2 focused tests:
  - happy path: HOME=/u/jinan → both paths root under it
  - whitespace-only HOME → resolved paths must NOT start
    with whitespace, must NOT be the bare relative
    `.muse/...`, and must end with the expected suffix
    (OR throw the "Cannot resolve" error on a CI where
    homedir() also returns empty)

## Verify

- New tests 2/2 green; full `@muse/cli` suite green (963
  passed, +2, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting just
  `lastChatHistoryPath` to the pre-fix `process.env.HOME
  ?? "~"` + `path.join(home, ...)` makes the whitespace-
  only test fail with the precise pre-fix symptom —
  `lastChatHistoryPath resolved path must NOT start with
  whitespace: expected '   /.muse/last-chat.jsonl' not to
  match /^\s/u`. Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure path resolvers — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended paths are the chat
  REPL's last-chat persistence and the activity-log
  writer, not the model loop.

## Status

Done. A pre-cleared `HOME=""` no longer makes Muse write
its chat history and activity log to `.muse/...` under the
operator's current working directory. The cross-CLI
empty-HOME fall-through convention now covers every
`HOME`-resolving path helper I could find:

- `defaultCredentialPath` (495)
- `defaultConfigPath` (505)
- `approvalsPath` / `trustPath` (539)
- `jobsDir` (540)
- `lastChatHistoryPath` / `activityLogPath` (this goal)

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; an empty-env-shadow `fix:`
on two more CLI path resolvers, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Step-8 redirect from the comparator-tiebreaker (546)
  back to the empty-env-shadow class on two fresh path
  resolvers. Different defect class than the immediate
  previous iteration; same class as 539/540, which closed
  a similar pair.
- Extracted a private `resolveHome()` helper rather than
  inlining the 3-line trim+fallback twice. Two callers in
  the same file with byte-identical behaviour — DRY is
  warranted. Future callers in the file can reuse it.
- Did NOT promote `resolveHome()` to `export`: it's an
  internal helper specific to this file's two public
  resolvers. Cross-file reuse would suggest lifting to
  `program-helpers.ts` (alongside `firstNonEmpty`), but
  the existing per-file pattern (495 in credential-store,
  505 in program-helpers) shows each file keeps its own
  HOME resolver — no leakage so far.
- The test uses a structured probe (returns
  `{kind: "ok"|"err"}`) instead of a try/catch around the
  expect block, after an initial draft hid an
  AssertionError inside the catch — the structured probe
  separates "did the function throw cleanly" from "did the
  assertions pass," so a future mutation can't be hidden
  by the same try/catch trick.
- The mutation reverts only `lastChatHistoryPath` (one of
  two identical fixes); the `activityLogPath` change is
  byte-identical in shape and the same mutation would fail
  identically. Cross-package convention is to test one
  representative when implementations are mechanical copies.
