# Iteration loop

Muse is developed as a personal-JARVIS-style AI conductor in a
continuous iteration loop. Every iteration is a fresh agent with no
prior context — read this file plus `git log --oneline -15` first.

## Per-iteration discipline

1. **Orient (≤ 2 minutes):**
   - `git log --oneline -15` is the running dev log; conventional
     commit messages carry the per-iter narrative
   - `git status -sb` (clean tree before starting)
   - skim `## [Unreleased]` in `CHANGELOG.md` only when the prior
     iter actually shipped user-visible behavior

2. **Pick exactly one goal** in priority order:

   1. **Real bugs** surfaced during dogfood or by users.
   2. **Personal-irrelevant code removal** — multi-tenant residue,
      RBAC roles, platform pricing, governance / approval workflows
      that don't make sense for a single user. The 1원리 test:
      "does a single user need this?"
   3. **Big-file decomposition** of any source file that has crept
      past the readable threshold (~700 LOC) without a clear
      reason.
   4. **JARVIS feature strengthening** — Notes / Tasks / Calendar
      polish, voice mode (see `docs/design/voice-mode.md`),
      external MCP UX, scheduler / reminder, user-memory capture,
      observability surfaces.

3. **Verify by HTTP, not just unit tests:**
   - `pnpm smoke:broad` for diagnostic-provider end-to-end
   - `pnpm smoke:live` (when a provider key is set) for
     real-LLM round-trip on any change to the request/response path

4. **Quality gates each iteration:**
   - `pnpm check` green (build + tests for every workspace)
   - `pnpm lint` 0 errors / 0 warnings
   - 1–2 conventional commits per iteration — the commit body IS
     the iter narrative, so write it sharply
   - `CHANGELOG.md` entries are **NOT** a per-iter requirement.
     Add a 1–3 line entry under `## [Unreleased]` only when an
     iter ships user-visible behavior (new feature, breaking
     change, real bug fix, public-API change). Internal refactors
     / lint sweeps / docs / decomp belong in commit messages, not
     in the changelog. Don't write paragraph-length entries —
     the git log already has the detail.

5. **Forbidden in iterations:**
   - Pushing to remote, force-push, `--no-verify` without
     explicit user approval
   - Adding emojis (CLAUDE.md rule)
   - Live credentials in commits
     (`MUSE_GCAL_CLIENT_SECRET`, `MUSE_CALDAV_APP_PASSWORD`,
     model API keys, …)
   - Bloating `CLAUDE.md` past 100 lines — add to
     `.claude/rules/<topic>.md`

## When you finish your iteration

Post a short summary, then return. The runtime fires the next
iteration automatically. If you discover a multi-iteration plan,
write it as a follow-up plan file under `docs/design/` so the next
iteration can resume.
