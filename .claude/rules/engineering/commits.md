# Commits & push policy

## Conventional Commits

- `feat:` user-visible feature or new project capability
- `fix:` bug fix
- `refactor:` behavior-preserving restructuring
- `test:` test-only change
- `docs:` documentation-only change
- `chore:` tooling, config, dependency, repository maintenance

Subjects and bodies are written in English.

Make small commits after coherent milestones. One iteration goal
per commit (or two when a `feat:` naturally pairs with a `test:`).
Don't mix unrelated work into one commit.

## Push policy

- **Standing authorization (Jinan, 2026-07-17):** after evaluator PASS,
  intended/clean commit scope, tier-appropriate green gates, `git fetch` +
  rebase, and the unskipped versioned pre-push hook, publish a normal push from
  the current Muse task branch (or verified local `main`) to its configured
  `origin` upstream without asking again. A verified slice is not complete
  while this allowlisted push remains pending.
- The standing authorization does **not** include alternate remotes or arbitrary
  refspecs, remote deletion, tags/releases, force/force-with-lease,
  `--no-verify`, skipped hooks, credentials, or branch-protection changes. On
  hook, authentication, protection, or unresolved divergence failure, make at
  most one safe fetch/rebase retry, then stop and report; never escalate to a
  destructive bypass.
- Scheduled/autonomous loops keep their declared Tier. A Tier that forbids push
  stays forbidden until separately opted in. Git publication does not weaken
  `../safety/outbound-safety.md`: sending/submitting/booking/posting toward a
  third party remains draft-first and explicitly confirmed.
- Don't commit live Jira / Confluence / Bitbucket / Slack-workspace credentials.
- Don't commit `.claude/scheduled_tasks.lock` or other transient session-state files.
- **Rebase onto `origin/main` before starting a slice AND again immediately
  before every push**: `git fetch origin && git rebase origin/main`. Several
  agents push from this repo on the same machine; a branch that's stale
  relative to origin is the #1 cause of a non-fast-forward rejection or a
  silent revert of someone else's just-landed work.

## Worktree & branch lifecycle

- **One slice = one branch with a FRESH descriptive name.** Never reuse a
  previous slice's branch for a new slice — reuse makes "is this merged
  yet?" ambiguous for anyone auditing branch state later.
- **Work in a dedicated worktree OUTSIDE the main checkout**
  (`~/muse-worktrees/<slice>`), never inside it — the main worktree belongs
  to the owner. A failed `cd` into that worktree is a **HARD STOP**: never
  run a git command after a `cd` you haven't confirmed succeeded — a stray
  git mutation lands in the owner's live main checkout instead.
- **On completion (evaluator PASS + pushed/merged to `origin/main`), delete
  the branch and remove the worktree IMMEDIATELY**: `git worktree remove
  <path>` and `git branch -d <branch>`. A finished worktree left behind is
  rot — it goes stale, a cleanup pass can GC it mid-use by someone else, and
  it confuses future merged-state audits.
- **Abandoned or blocked work is never silently left in a dangling
  worktree.** Either commit a WIP to its branch with a defer note explaining
  why, or remove the worktree/branch outright.
- **Sweep check after each batch of slices**: `git branch --merged
  origin/main` should list no leftover slice branches — any that show up
  are cleanup debt, not history.

## Versioned git hooks (`scripts/githooks/`, wired via `core.hooksPath`)

Hooks live in `scripts/githooks/` (checked in) instead of the unversioned
`.git/hooks/*` — `scripts/setup-githooks.mjs` points `core.hooksPath` there
(runs automatically on `pnpm install` via `postinstall`; safe to re-run).
`core.hooksPath` is a normal, non-worktree-scoped git config key, so it is
**shared across every worktree of the repo** — setting it from any worktree
affects all of them.

`pre-push` runs five stages in order:

1. **Push-window lock** (`scripts/githooks/lib/pushlock.sh`) — serializes the
   whole hook run (and the `git push` right after it) across same-machine
   agents, closing the race where several agents pass their checks against a
   stale branch tip and then collide pushing at once. macOS ships no
   `flock(1)`, so the primary mechanism is a portable mkdir-spinlock (`mkdir`
   is atomic on any POSIX filesystem) with a ~10-minute stale-lock timeout so
   a crashed holder can't deadlock every future push.
2. **Fail-CLOSED scope classifier** — unions the changed paths from every
   pushed ref. Docs/assets-only pushes skip deterministic gates; known code
   paths select the relevant gates. Missing/malformed ref input, unknown Git
   objects, diff failures, and unclassified paths all fall back to the full
   gate rather than guessing that a push is safe.
3. **Fail-CLOSED deterministic gates** — code/config changes run
   `pnpm -s typecheck:fast`; web-impacting changes also run the direct
   `apps/web` typecheck (outside the `tsc -b` reference graph by design, see
   `architecture.md`). ESLint receives existing changed source files, while
   lint config/dependency or fallback scope runs the full lint. A required
   gate whose environment cannot resolve `pnpm` is blocked. If a newly added
   dependency is missing locally, run `pnpm install --frozen-lockfile`.
4. **Fail-CLOSED documentation reference gate** — any pushed `.md` (or anything
   under `docs/` or `.claude/rules/`) runs `node scripts/check-doc-links.mjs`,
   which resolves every relative link, every `#fragment` against the target's
   real headings, and every frontmatter `related:` entry across all markdown.
   It is pure node, so it also covers a docs-only push, which skips stage 3
   entirely — that gap is how a docs refactor once shipped broken links. Code
   spans and fenced blocks are stripped first: `` `![](exfil)` `` in an
   injection-test note is not a link. A tree that predates the checker reports
   a visible skip instead of blocking.
5. **Explicit live grounding tripwire** — grounding is not part of the
   default local push latency. Set `MUSE_RUN_PREPUSH_GROUNDING=1` to run
   `pnpm -s precheck:grounding` when the pushed paths affect grounding. It
   remains fail-open when pnpm/Ollama cannot be reached.

The controls are documented and greppable — prefer them to `--no-verify`:

- `MUSE_RUN_PREPUSH_GROUNDING=1` — opts into stage 4 for a relevant push.
- `MUSE_SKIP_PREPUSH=1` — explicitly suppresses stage 4 only; deterministic
  gates still run. Kept for compatibility with existing automation.
- `MUSE_SKIP_PREPUSH_ALL=1` — skips every stage, including the compile gate.
  Genuine emergencies only.

## After-correction protocol

When the user corrects Claude on a recurring mistake, end the
iteration by adding the rule to the matching `.claude/rules/*.md` (or
open a new rules file). The goal is for the rule set to absorb every
correction so the same mistake doesn't recur.
