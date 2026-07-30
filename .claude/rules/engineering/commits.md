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

## Versioned git hooks

Hooks are checked into `scripts/githooks/` and wired via `core.hooksPath`, which is
shared across every worktree of the repo. `pre-push` runs, in order: a push-window lock,
a fail-closed scope classifier, the documentation reference gates, the deterministic
compile/lint gates, and an opt-in grounding tripwire. Mechanism and per-stage detail:
[`scripts/githooks/README.md`](../../../scripts/githooks/README.md).

The escape hatches are greppable — prefer them to `--no-verify`:

- `MUSE_RUN_PREPUSH_GROUNDING=1` — opt INTO the grounding tripwire for a push that
  touches grounding.
- `MUSE_SKIP_PREPUSH=1` — suppresses the grounding tripwire only; every other gate still
  runs. Kept for compatibility with existing automation.
- `MUSE_SKIP_PREPUSH_ALL=1` — skips every stage including the compile gate. Genuine
  emergencies only.

## After-correction protocol

When the user corrects Claude on a recurring mistake, end the
iteration by adding the rule to the matching `.claude/rules/*.md` (or
open a new rules file). The goal is for the rule set to absorb every
correction so the same mistake doesn't recur.
