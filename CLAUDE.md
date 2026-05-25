# Muse

Muse is a provider-neutral, JARVIS-style AI conductor. The runtime
orchestrates any LLM, any tool, any MCP server — without hard-wiring
a vendor SDK into core code.

This file is the **contract** every Claude Code agent reads first.
Keep it under 100 lines. Anything longer goes in `.claude/rules/*.md`.
When the user corrects a recurring mistake, end the iteration by
adding the rule there — this file should shrink, not grow.

## Dev cycle (inner loop)

```bash
# while developing — fast feedback per change:
pnpm --filter @muse/<name> build       # one package
pnpm --filter @muse/<name> test        # one package
pnpm test -- -t "<test name>"          # single test by name

# before commit:
pnpm check                             # build + test for every workspace

# before claiming "this works" on the full system:
pnpm smoke:broad                       # broad HTTP smoke, diagnostic provider (no key)
pnpm smoke:live                        # real LLM round-trip — LOCAL OLLAMA QWEN ONLY (no cloud APIs)

# before commit (lint gate):
pnpm lint                              # 0 errors / 0 warnings required
```

These commands are the ground truth. If any fails, stop and triage.

## Non-negotiables

- `agent-core` is model-agnostic. Provider SDKs live behind `packages/model` adapters only.
- Guards are fail-close. Hooks are fail-open. Security is deterministic code, never prompt instruction.
- Tool output is untrusted. Tool loops have explicit limits and timeouts.
- Risky local execution flows through `crates/runner`.
- Server, CLI, and any future surface share the same `agent-core` runtime.
- Outbound to a third party (send email/message, submit/book, post) is fail-close & draft-first per [`outbound-safety.md`](.claude/rules/outbound-safety.md) — never an autonomous send.
- Tests are the only form of verification. **`smoke:broad` (diagnostic) is the start, not the finish — `smoke:live` is what proves a real-LLM round-trip still works.**

## Don't

- Don't make OpenAI / Anthropic / Vercel-AI-SDK / LangGraph the runtime owner.
- Don't push, force-push, or `--no-verify` without explicit user approval.
- Don't commit live Jira / Confluence / Bitbucket / Slack-workspace credentials.
- Don't bloat this file past 100 lines — add to `.claude/rules/<topic>.md` instead.
- Don't accept "passes diagnostic smoke" as proof — run `smoke:live` for any change in the request/response path.
- Don't connect to bank / brokerage accounts or move money — financial-account access is permanently out of scope (`outbound-safety.md`).

## Domain rules

For depth, read the matching file under `.claude/rules/`:

- [`architecture.md`](.claude/rules/architecture.md) — package layout, ModelProvider contract, fallback policy, provider-specific schema quirks (Gemini sanitiser).
- [`cli-product.md`](.claude/rules/cli-product.md) — CLI surface (commander, Ink, config paths, runner boundary).
- [`testing.md`](.claude/rules/testing.md) — verification gates and the narrowest-useful-test rule.
- [`commits.md`](.claude/rules/commits.md) — Conventional Commits + push policy + after-correction protocol.
- [`code-style.md`](.claude/rules/code-style.md) — ESLint gate, naming, comment policy, dead-import rule.
- [`outbound-safety.md`](.claude/rules/outbound-safety.md) — fail-close gate for any send/act toward a third party; banking out of scope.
- [`tool-calling.md`](.claude/rules/tool-calling.md) — the local Qwen must pick the right tool in ONE shot: small tool sets, unambiguous names, rich schemas, verify selection with `smoke:live`.

## Cross-session memory

Auto-memory persists at
`~/.claude/projects/-Users-jinan-side-project-Muse/memory/MEMORY.md` —
a one-line index pointing to user / feedback / project / reference
notes built up over iterations. Read `MEMORY.md` first; it tells you
which detail files (`feedback_loop_behavior.md`,
`project_muse_identity.md`, …) are relevant.

For broader product context, see [`AGENTS.md`](AGENTS.md) and
[`CHANGELOG.md`](CHANGELOG.md).
