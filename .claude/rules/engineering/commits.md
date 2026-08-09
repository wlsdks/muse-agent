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
- **Standing completed-branch cleanup authorization (Jinan, 2026-08-09):** after
  a task branch is merged to fresh `origin/main`, remove its worktree and local
  branch, then run `node scripts/cleanup-merged-remote-branches.mjs --delete
  <exact-branch>`. That command is the only authorized remote-deletion path: it
  fixes the remote to `origin` and fails closed unless every named task ref is
  fully contained in `origin/main`, inactive in registered worktrees, has no
  open pull request, and retains the exact verified remote tip through an atomic
  compare-and-delete. The helper also requires GitHub protection on `main` to
  block force pushes and branch deletion with admin enforcement, so containment
  remains monotonic while candidate refs are compared server-side. The helper's per-ref
  `--force-with-lease=refs/heads/<branch>:<verified-sha>` is the sole
  force-with-lease exception; it is a server-side expected-tip guard, not
  authority to update or overwrite a branch.
- The standing authorizations do **not** include alternate remotes or arbitrary
  refspecs, ad hoc remote deletion, tags/releases, general force/force-with-lease,
  `--no-verify`, skipped hooks, credentials, or branch-protection changes. The
  owner-approved initial protection setup is not standing authority to change it
  later. On
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
- After the worktree and local branch are gone, delete the completed remote task
  branch through `cleanup-merged-remote-branches.mjs`. Never call `git push
  --delete` directly or construct a lease by hand. If containment, open-PR,
  worktree, tip, `gh`, atomic-push support, or remote
  state cannot be verified, leave the remote branch intact and report why.
- **Abandoned or blocked work is never silently left in a dangling
  worktree.** Either commit a WIP to its branch with a defer note explaining
  why, or remove the worktree/branch outright.
- **Sweep check after each batch of slices**: `git branch --merged
  origin/main` should list no leftover local slice branches. Enumerate `git
  branch -r --merged origin/main`, then pass each exact remote task name to the
  cleanup command's dry-run; any eligible leftovers are cleanup debt, not history.

## `review-tier:` is required, and checked

A `feat`/`fix`/`refactor`/`perf` commit body must carry one line:
`review-tier: independent-evaluator | thin-review | n/a`. `guard-review-tier.mjs`
(commit-msg) blocks the commit without it, and REFUSES the thin tier when the diff
touches a surface where the evaluator is unconditional — migrations, SQL,
credential/auth/approval/consent/policy/guard sources, `scripts/githooks/`, or the
policy/secrets/quarantine-eval packages.

A mandatory surface demands the tier **whatever the subject says** — the commit type is the
author's own claim about risk, and this gate exists because a claim about risk is not
evidence.

It cannot verify that an evaluation happened. It forces the claim to exist in a fixed
vocabulary so a reader can check it against the diff — "the evaluator passed" used to be
a claim no script could audit. When editing the surface list, check it against
`git ls-files`: the first version anchored each keyword to the start of the basename and so
missed `channel-approval-gate.ts`, while blocking an `approval-gate.ts` that does not exist.

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
