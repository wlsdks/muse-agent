---
name: migrate-iteration
description: Run one Reactor → Muse migration iteration end-to-end
---

Continue the Reactor → Muse migration in `/Users/stark/ai/Muse` for
one productive iteration. Read `.claude/rules/migration-loop.md` and
`docs/migration-plan.md` first, then `git log --oneline -20`.

Pick exactly one concrete gap (deep behavior parity, code quality,
JARVIS capability, or generic MCP integration) and close it.

Mandatory each iteration:

1. Verify by HTTP — `pnpm smoke:broad` and (if a provider key is set) `pnpm smoke:live`.
2. `pnpm check` green, `verify:reactor-routes` 0 missing,
   `verify:reactor-db` 0 missing if schema changed.
3. 1–2 conventional commits; append a one-liner to
   `docs/migration-plan.md`'s "Recent Completion Notes".
4. No push, no force, no live workspace credentials.

End the turn with a short summary so the next iteration can pick up.
