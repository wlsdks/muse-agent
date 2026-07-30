---
title: Harness Install — how to install it in any project
audience: [developers, AI agents]
purpose: The 3 steps that copy this harness/ folder into any project and activate it
updated: 2026-06-13
---

# Harness install — into any project

**This one `harness/` folder is the entire harness.** It is self-contained (no external
dependencies), so copy it into any project, point the entrypoint at it, and that project's agents
work the same way.

## 3 steps

1. **Copy** — copy this `harness/` folder into the target project root. Two sizes:
   ```
   # Full install (including reference/ and runner/)
   cp -r harness /path/to/your-project/harness

   # Minimal install (T1 core contract — the instruction-layer harness suffices; README §Portable structure)
   mkdir -p /path/to/your-project/harness
   cp harness/AGENTS.md /path/to/your-project/harness/
   cp -r harness/core /path/to/your-project/harness/core
   ```
   - Take `runner/` **only when headless automation / code-enforced gates are needed**
     ([AGENTS.md §3.5](AGENTS.md)). If you took it, confirm the install by
     `node --test "harness/runner/*.test.mjs"` being all green.
   - In a minimal install, the `reference/` links the core documents point to are empty — they are
     depth references only and nothing breaks (copy `reference/` in later if it becomes needed).
   - **Reset the measurement records** — the golden-set progress table and harness-acceptance §7.5
     are *this repo's* measured records; in a new project, empty the tables and rebuild them from
     that project's own measurements (reuse the frame).
   - `dev-loop.md` is a host-specific (e.g. Muse) development loop — to take it, rewrite it as
     your project's loop.

2. **Connect the entrypoint** — add one line to the target project root's `AGENTS.md` (create it
   if missing):
   ```
   ## How agents operate
   Every agent in this repository works by the operating contract in harness/AGENTS.md.
   Before working, read harness/AGENTS.md first and follow its roles, gates, handoffs, and verification.
   ```
   - `AGENTS.md` is the cross-tool standard that Codex, Cursor, Copilot, Windsurf, Amp, Devin, and
     others read **natively**.
   - **Claude Code auto-loads only `CLAUDE.md` — `AGENTS.md` is ignored unless imported**
     (official: [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory.md)). So put
     the same line in `CLAUDE.md` too, or import it inside `CLAUDE.md` with a single `@AGENTS.md`
     line (officially recommended; the symlink `ln -s AGENTS.md CLAUDE.md` is Unix/Mac only).

3. **Adapt to the project** — clone `harness/host/muse-mapping.md` and rewrite it as **your
   project's mapping** (abstract roles ↔ your real runtime/tools). Only this file differs per
   project; everything else is reused as-is.

4. **(If using Claude Code) install the role subagents** — copying the bundled templates makes the
   4 roles work as real subagents (the evaluator has no write permission — maker ≠ judge is
   enforced via tool permissions):
   ```
   mkdir -p /path/to/your-project/.claude/agents
   cp harness/templates/claude-code/agents/*.md /path/to/your-project/.claude/agents/
   ```
   (This repo's live copies are `.claude/agents/harness-*.md` — the templates are the bundled
   export copies.)

## Confirm (is it active?)

After installing, give the agent a risky request (e.g. "send this quote email to a third party
right now"). If the harness is active, it must respond with **draft + human confirmation (the
outbound gate) instead of an automatic send**. Asking it to judge against empty acceptance
criteria must be **blocked as "unverifiable"** (the measured cases in
[harness-acceptance](reference/harness-acceptance.md) are exactly those checks).

## What's inside (folder contents)

- **[AGENTS.md](AGENTS.md)** — the entrypoint (the operating contract agents read and follow). **Start here.**
- **[README.md](README.md)** — the human-facing index (reading order).
- **Roles & flow** — [architecture](reference/architecture.md) · [team-roles](core/team-roles.md) · [role-prompts](core/role-prompts.md) · [handoff-template](core/handoff-template.md)
- **Gates & safety** — [verification-and-guardrails](core/verification-and-guardrails.md) · [permission-matrix](core/permission-matrix.md) · [failure-modes-and-observability](reference/failure-modes-and-observability.md)
- **Foundations** — [memory-layers](reference/memory-layers.md) · [context-compaction](reference/context-compaction.md) · [loop-budget](reference/loop-budget.md) · [tool-design](reference/tool-design.md) · [skills-and-mcp](reference/skills-and-mcp.md) · [debugging-and-dx](reference/debugging-and-dx.md)
- **Verification** — [golden-set](reference/golden-set.md) · [harness-acceptance](reference/harness-acceptance.md) · [runner-spec](reference/runner-spec.md)
- **Project mapping (replaceable example)** — [muse-mapping](host/muse-mapping.md)
