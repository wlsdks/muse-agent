---
title: Roles — write boundaries and the counter-principles
audience: [AI agents]
purpose: The parts of team composition that contract.md does not carry — per-surface write boundaries, and the cases where the obvious move is wrong
updated: 2026-07-30
related: [contract.md, handoff.md]
---

# Roles

[`contract.md`](contract.md) §2 defines who does what and which roles are mandatory. This file
carries the two things that do not fit there: the **write boundaries** each role has per work
surface, and the handful of **counter-principles** where the obvious move is the wrong one.

## 1. Counter-principles

- **Multi-agent costs 4–15× the tokens of one agent.** Spend it only where the work genuinely
  decomposes into independent threads.
- **When outputs must interlock, a single thread wins.** Parallel workers who cannot see each
  other's full context work under conflicting implicit assumptions, and merging at the end still
  yields mismatched results. Split reads, exploration and judging; keep converging **writes** on
  one thread. When context gets long, compact rather than split.
- **A clean context is the reviewer's feature, not a limitation.** A reviewer with no task history
  catches ~2 bugs per PR, 58% of them severe (Cognition, 2026). So hand a reviewer the diff and the
  criteria only — and say "flag only gaps that affect correctness", because asked to find gaps a
  model always will.
- **Never auto-generate the rules file.** LLM-generated team-rule documents measurably lower
  success rates. Every line here is written by a human or by an agent acting on a human's
  correction.
- **3–5 roles is the ceiling for one team.** Past that, scale as a hierarchy — a feature lead
  spawning its own sub-team — not one flat team.

## 2. Maker/evaluator permissions per work surface

`read-only evaluator` does not simply mean "no Edit tool". Evaluation commands or a browser can
write state, so: **the repo and owner state are read-only**, and any reproduction that needs
writes is allowed only against a **disposable fixture the evaluator created**. Maker and evaluator
never use the same checkout/file at the same time.

| Surface | Maker/worker and allowed writes | Independent evaluator: allowed reads/execution | Forbidden to the evaluator | Gate strength |
| --- | --- | --- | --- | --- |
| Runtime | A single worker writing only the active slice's runtime source/test/config. Runs the named narrow tests/traces. | From a fresh context, reads the handoff, acceptance slice, current diff/source, traces; reproduces normal/failure/cancel/retry in isolated processes and fixtures. | Editing the repo, reusing the worker's process/state, mutating owner daemon/scheduler state, fixing a FAIL directly. | Process/scheduler/concurrency boundaries that need Sol/high for both controller/maker and evaluator start at that strength. |
| Store / persistence | Writes only the active store/schema/migration and its migration tests; builds backup/restore/rollback acceptance alongside. | Reads schema/diff; runs round-trip, corruption, and rollback against a disposable database or a temp-HOME clone. | Modifying the owner DB, `~/.muse`, or backups; applying real migrations; promoting fixture results to organic evidence; fixing a FAIL directly. | Persistence/migration: Sol/high for both maker and fresh evaluator; the final release verdict follows its own gate. |
| Security / permission / credential | One Sol/high maker writes scoped guard/policy/tests. Real secrets never enter code or the handoff. | A fresh evaluator reads the artifact/diff and redacted fixtures; runs adversarial deny-paths in a sandbox. | Reading/copying credentials, issuing/changing grants/approvals/policy, external egress, editing the repo, fixing a FAIL directly. | The final security/credential gate is a fresh Sol/xhigh. |
| UI / browser | Writes only active UI source/tests and disposable state for the evaluator. | A fresh evaluator reads the current build and acceptance; observes via Chromium/Playwright in an isolated browser profile/test account, including accessibility and failure states. | Mutating the user's real browser profile, clipboard, downloads/uploads, account state; arbitrarily refreshing snapshot approvals; editing the repo; fixing a FAIL directly. | Ordinary UI: a fresh evaluator at matching risk; upload/download and computer-control boundaries start at Sol/high. |
| Release / publication | The controller prepares the verified commit candidate and provenance. Beyond a normal push within standing authorization, tag/release/publication is a separate permission. | From a fresh checkout, reads and reproduces HEAD/time/input hashes, required checks, rollback artifacts, remote state. | Modifying source; tag/release/publish/push; changing credentials/protection; using a stale artifact as green; fixing a FAIL directly. | The final release gate is a fresh Sol/xhigh; even an evaluator PASS is not publication permission. |

(`Sol/high` / `Sol/xhigh` are gate-strength shorthand — the strongest review model tier at
high/xhigh effort. Current mapping: [contract.md §7](contract.md).)

Restrict the inputs handed to the evaluator to this allowlist:

1. the activation/handoff and the structured acceptance slice,
2. the current artifact or commit/diff to judge, with directly related source,
3. the verification commands, fixtures, and provenance to reproduce,
4. already-known blockers and the previous evaluator's **concrete verdicts** (re-evaluation cycles
   only).

Do not pass the maker's full conversation, hidden reasoning, self-evaluation, or unrelated dirty
files. The evaluator does not fix the permanent handoff or the repo; it returns PASS/FAIL with
per-criterion evidence, and the controller records it. If a fresh context is impossible, record
`unseparated self-evaluation`, not PASS.

## Sources

- Anthropic — [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) · [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Addy Osmani — [The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/) (3–5 team · verification bottleneck · worktree isolation)
- Cognition — [Multi-Agents: What's Actually Working](https://cognition.ai/blog/multi-agents-working) (clean-context reviewer ~2 bugs/PR, 58% severe)
