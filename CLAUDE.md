# Muse

**Product goal: Muse learns how one user lives and works, and gets better at when and how to help.**
Attunement is the product north star: personal thread → Continuity Pack → outcome → adaptation.
Optional Observe may later improve timing through rhythm and friction evidence. The complete loop
is ROADMAP, not a shipped claim — memory, pattern, proactivity, browser, trace, and checkpoint
features are substrates; never relabel them as end-to-end Attunement. The first vertical is
Personal Continuity: a user-chosen unfinished life or work thread, initially backed by Muse-local
artifacts and optional browser history. Work Resumption is one specialized mode, not the product
boundary.

Provider/MCP-neutrality, local-first ownership, deterministic grounding, correction, and
draft-first action are the TRUST FLOOR. Muse can use cloud or local models; `MUSE_LOCAL_ONLY=true`
explicitly refuses cloud egress in code. Supported grounded personal-data paths must cite their
sources, lower weak matches, and drop invalid citations — do not claim universal citation coverage
or fabrication=0, fast uncited chat still has a documented gap. Keep the existing per-surface
grounding ratchets intact. Observe must be visible, pausable, inspectable, forgettable, and must
not persist raw keystrokes or continuous screen capture by default. Never make a cloud vendor the
runtime owner or hard-wire a vendor SDK into core code. Product contract: [`docs/strategy/attunement.md`](docs/strategy/attunement.md).

This file is the **contract** every Claude Code agent reads first — keep it under 100 lines.
Anything longer goes in `.claude/rules/*.md`. When the user corrects a recurring mistake, end the
iteration by adding the rule there — this file should shrink, not grow.

## Dev cycle (inner loop)

```bash
# while developing — fast feedback per change:
pnpm --filter @muse/<name> build       # one package
pnpm typecheck:fast                    # TypeScript 7 project graph, no test fan-out
pnpm test:changed                      # ONLY the tests related to your git-changed files (vitest related) — the DEFAULT per-edit gate, NOT a whole package suite
pnpm test:changed --uncommitted        # tighter: uncommitted changes only (mid-edit inner loop)
pnpm --filter @muse/<name> test        # one whole package (heavier — use only when a change is broad)
pnpm test -- -t "<test name>"          # single test by name

# before commit:
pnpm check                             # build + test for every workspace

# before claiming "this works" on the full system:
pnpm smoke:broad                       # broad HTTP smoke, diagnostic provider (no key)
pnpm smoke:live                        # real LLM round-trip — LOCAL OLLAMA ONLY, gemma4:12b default (no cloud APIs)

# before commit (lint gate):
pnpm lint                              # 0 errors / 0 warnings required
```

These commands are the ground truth. If any fails, stop and triage.

For TypeScript/toolchain work, follow [`docs/development/typescript-7.md`](docs/development/typescript-7.md):
normal builds use TS7, while the `typescript` dependency intentionally remains the TS6
compiler-API compatibility alias for tooling. Do not mask migration diagnostics with
compiler-option relaxations.

**To decide what to work on next, run the `improve-muse` skill** — it finds the work
(regression → backlog → gap-scout) and ends with a ranked recommendation; "nothing to do"
is a forbidden output. Building the picked slice follows [`harness/host/dev-loop.md`](harness/host/dev-loop.md) §3.

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
- [`tool-calling.md`](.claude/rules/tool-calling.md) — the local model (gemma4:12b default) must pick the right tool in ONE shot: small tool sets, unambiguous names, rich schemas, verify selection with `smoke:live`.
- [`agent-testing.md`](.claude/rules/agent-testing.md) — how we evaluate the AGENT (not just code): grade outcomes not paths, `pass^k` reliability, tool-calling + irrelevance, multi-agent hand-off/termination asserts, binary LLM-judge w/ meta-eval; research-grounded.
- [`codegraph.md`](.claude/rules/codegraph.md) — prefer the CodeGraph (`.codegraph/`) index for structural code questions; answer directly in a few calls, never a grep/read loop.
- [`harness.md`](.claude/rules/harness.md) — for non-trivial multi-step work, operate under the portable agent harness in `harness/` (roles, fail-closed gates, handoff, pass^k verification); entrypoint `harness/AGENTS.md`.

## Cross-session memory

Auto-memory persists at `~/.claude/projects/-Users-jinan-side-project-Muse/memory/MEMORY.md` — a
one-line index pointing to user / feedback / project / reference notes built up over iterations.
Read `MEMORY.md` first; it tells you which detail files (`feedback_loop_behavior.md`,
`project_muse_identity.md`, …) are relevant.

For broader product context, see [`AGENTS.md`](AGENTS.md) and [`CHANGELOG.md`](CHANGELOG.md).
