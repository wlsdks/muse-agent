# Feature ↔ Use-case Documentation Audit — Design

Date: 2026-05-25
Branch: `docs/feature-usecase-audit` (worktree, based on local HEAD)
Author: planner-agent team (lead + 4 auditors + 1 reviewer + 1 writer)

## Problem

The user asked three questions about Muse's documentation:

1. Is there a planning doc / PRD, and are `docs/*.md` + README accurate?
2. Are they up to date?
3. Does **every feature actually have a use case** — or are there features
   in code that no real user scenario justifies, and use cases promised in
   docs that no code backs?

A first survey found docs are *current* but vision is *scattered* (no single
PRD), one hard bug (`CLAUDE.md` memory path points at the old
`-Users-stark-ai-Muse`), and the feature↔use-case mapping has never been
verified end to end.

## Goal

Produce a **full cross-reference audit** of Muse's user-facing surface
(every CLI command, MCP server / MuseTool, model provider, and key
subsystem) that answers, with evidence, for each feature:

> feature → user use-case → code path (`file:line`) → test → status

and then update the **product-facing docs** to match verified reality.

## Scope

**In scope (editable):**
- `docs/audit/2026-05-25-feature-usecase-audit.md` — the audit matrix (new)
- `docs/FEATURES.md` — Korean feature inventory (reconcile to verified reality)
- `README.md`, `AGENTS.md` — product positioning + add "what Muse cannot do"
  + a current-status snapshot
- `CLAUDE.md` line 67 — fix the memory path bug
  (`-Users-stark-ai-Muse` → `-Users-jinan-side-project-Muse`)

**Off-limits (read-only — loop-owned / IMMUTABLE-CORE):**
- `.claude/rules/iteration-loop.md`, `docs/goals/OUTWARD-TARGETS.md`
  (carry `IMMUTABLE-CORE` sentinels — commit-msg hook rejects edits)
- `docs/goals/CAPABILITIES.md`, `docs/goals/NNN-*.md`, `docs/EXPANSION-*`
  (loop-owned; cite only)

Issues found in off-limits files are **reported in the PR body**, never edited.

## Team & flow (approach A: domain-split audit + cross-review)

1. **Lead (me):** extract the ground-truth checklist from code so auditors
   cannot miss or invent features; own the matrix schema and final reconcile.
2. **4 auditors (parallel), each on an independent slice:**
   - A1 CLI surface (`apps/cli`)
   - A2 MCP servers + MuseTools (`packages/mcp`, tool registry)
   - A3 model providers (`packages/model`)
   - A4 subsystems (calendar, memory, scheduler, voice, multi-agent,
     messaging, policy/guards)
   Each fills its matrix rows with **`file:line` evidence** for every claim.
3. **Reviewer (red-team):** re-checks every status / use-case claim against
   code; any unbacked row is rejected back to the matrix.
4. **Writer:** updates product docs using **only** reviewer-verified rows.

## Matrix row schema

| feature | surface (CLI/MCP/API) | user use-case | code (`file:line`) | test | status |

Status legend:
- ✅ **verified** — code + test exist and a real user use-case is named
- ⚠️ **stale** — doc claims diverge from code
- 🕳️ **gap** — use-case promised in docs, no/weak code or test backing
- 👻 **orphan** — code exists, no named user use-case (candidate for "why?")

## Verification gates (doc change, run hard anyway)

- Every `file:line` claim in the matrix resolves to a real line (reviewer).
- `pnpm lint` → 0/0.
- `pnpm check` → build not broken by doc/markdown changes.
- Zero false claims is the merge-blocking condition.

## Done & merge

- Commit on `docs/feature-usecase-audit`.
- Local PR-style review: present `git diff main...docs/feature-usecase-audit`
  to the user; **merge into local main only after explicit approval**.
- No GitHub push (local `main` is 6 commits ahead of `origin/main`; the loop
  owns that state).

## Risks

- The autonomous loop commits to local `main` every ~10 min and may touch
  `FEATURES.md` concurrently → keep the branch short, rebase before merge,
  surface in the PR.
- Large surface (~120 CLI command/subcommand registrations) → auditors work
  from the lead's fixed checklist, evidence-required, reviewer-gated.
