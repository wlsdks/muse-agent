# `scripts/githooks/`

Checked-in git hooks, wired by `scripts/setup-githooks.mjs` pointing `core.hooksPath`
here (runs on `pnpm install` via `postinstall`; safe to re-run). `core.hooksPath` is a
normal, non-worktree-scoped config key, so setting it from any worktree affects **every**
worktree of the repo.

The binding rule — what is forbidden, and the escape hatches — is
[`.claude/rules/engineering/commits.md`](../../.claude/rules/engineering/commits.md).
This file is the mechanism behind it.

## `pre-push`, in order

1. **Push-window lock** (`lib/pushlock.sh`) — serializes the hook run and the `git push`
   right after it across same-machine agents, closing the race where several agents pass
   their checks against a stale tip and then collide. macOS ships no `flock(1)`, so the
   mechanism is a portable mkdir-spinlock (`mkdir` is atomic on any POSIX filesystem)
   with a ~10-minute stale-lock timeout so a crashed holder cannot deadlock every future
   push.
2. **Fail-closed scope classifier** — unions the changed paths across every pushed ref.
   Docs/assets-only pushes skip the deterministic gates; known code paths select the
   relevant ones. Missing or malformed ref input, unknown git objects, diff failures and
   unclassified paths all fall back to the FULL gate rather than guessing a push is safe.
3. **Documentation reference gate** — runs on any pushed `.md`, or anything under `docs/`
   or `.claude/`: `check-doc-links.mjs` (relative links, `#fragment`s against real
   headings, frontmatter `related:`, and backticked repo paths inside `.claude/**`),
   `check-doc-claims.mjs` (every documented `pnpm` command exists) and
   `check-agent-registry.mjs` (agent filename equals frontmatter `name:`). All pure node,
   so they also cover a docs-only push — which skips stage 4 entirely, and that gap is
   how a docs refactor once shipped broken links. A tree predating a checker reports a
   visible skip instead of blocking.
4. **Deterministic gates** — `check-refs.mjs` (a missing project reference means `tsc -b`
   silently skips that rebuild), then `pnpm -s typecheck:fast`; web-impacting changes also
   run the direct `apps/web` typecheck, which is outside the `tsc -b` reference graph by
   design. ESLint receives the changed source files; a lint-config or dependency change
   runs the full lint. A required gate whose environment cannot resolve `pnpm` is blocked
   rather than skipped. If a newly added dependency is missing locally, run
   `pnpm install --frozen-lockfile`.
5. **Live grounding tripwire** — opt-in only, so grounding is not part of default push
   latency. `MUSE_RUN_PREPUSH_GROUNDING=1` runs `pnpm -s precheck:grounding` when the
   pushed paths affect grounding. Fail-open when pnpm or Ollama cannot be reached.

## `commit-msg`

Runs `scripts/guard-writeback.mjs`: a non-trivial `feat:`/`fix:` must stage a compounding
artifact (a regression test, a golden eval case, or a backlog advance), or say
`[writeback: n/a]` explicitly.
