---
title: Tool surface security — MCP servers and self-authored skills
audience: [AI agents]
purpose: How to choose a loop's external tool surface so injection defense is structural rather than an instruction
updated: 2026-07-30
related: [loop-engineering.md, ../../../../.claude/harness/contract.md]
---

# Tool surface security — MCP servers and self-authored skills

A loop that pulls in external tools or promotes self-authored skills widens its own attack
surface. **Injection defense is an architectural property, not an instruction** — a prompt asking
the model to distrust tool output does not survive an 8B model, let alone an adversary. Design the
surface so the attack cannot land.

The enforced mechanics already exist and are owned elsewhere: the two-stage MCP allowlist
(checked at register AND re-checked at connect) is `.claude/rules/engineering/architecture.md`;
draft-first confirmation for anything outbound is `.claude/rules/safety/outbound-safety.md`. This
file is only the design guidance a loop author needs on top of them.

## The four structural patterns

- **Forbid the lethal trifecta** — ① access to private data ② receiving untrusted content ③ an
  outbound channel. Design so the three **never coexist in one agent or one turn** (Willison).
  In permission terms: once a context has read untrusted input, the outbound tier becomes
  **refusal**, not approval.
- **Fix control flow BEFORE reading untrusted data** — derive the plan (which tools, in which
  order) from the trusted user query first. Untrusted tool output may fill arguments and **must
  never rewrite the plan**. CaMeL solved 77% of AgentDojo tasks with *provable* security this way.
- **Least privilege is measured, not theoretical** — deterministic per-tool, per-argument
  permission policies alone dropped indirect-injection attack success **41.2% → 2.2%** (Progent)
  with utility preserved. Any *expansion* of privilege requires human approval.
- **Pick the weakest pattern that still fits** — of action-selector / plan-then-execute /
  LLM map-reduce / dual LLM (privileged + quarantined) / code-then-execute /
  context-minimization, choose the one that costs the least utility (2506.08837).

## For a self-authored skill

A skill the agent wrote for itself, or received, **stays disabled and quarantined until a human
promotes it** — nothing runs on arrival. Anything needing execution permission never
auto-activates. This is what keeps a self-improving loop from writing its own escalation.

## Sources

- Simon Willison — [The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)
- Google DeepMind — [CaMeL: Defeating Prompt Injections by Design (2503.18813)](https://arxiv.org/abs/2503.18813)
- [Progent (2504.11703)](https://arxiv.org/abs/2504.11703) — per-tool/per-argument least-privilege DSL, ASR 41.2%→2.2%
- [Design Patterns for Securing LLM Agents (2506.08837)](https://arxiv.org/abs/2506.08837) — the six provable patterns
- OWASP — [Secure MCP Server Development](https://genai.owasp.org/resource/a-practical-guide-for-secure-mcp-server-development/)
- NVIDIA — [Sandboxing Agentic Workflows](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)
