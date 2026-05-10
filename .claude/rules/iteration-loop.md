# Iteration loop

Muse is developed as a personal-JARVIS-style AI conductor in a
continuous iteration loop. Every iteration is a fresh agent with no
prior context — read this file plus `CHANGELOG.md` first.

## Per-iteration discipline

1. **Orient (≤ 2 minutes):**
   - `git log --oneline -15`
   - read the most recent entries under `## [Unreleased]` in
     `CHANGELOG.md`
   - `git status -sb` (clean tree before starting)

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
   - 1–2 conventional commits per iteration
   - new entry under `## [Unreleased]` in `CHANGELOG.md`

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
