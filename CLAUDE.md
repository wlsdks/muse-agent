# Muse

**Muse learns how one person lives and works, and gets better at when and how to help.** Every slice
you land here makes one real owner's daily life smoother — that is who the work is for. North star —
Attunement: Shadow Muse → Continuity Capsule → visible Policy Card. Product contract:
[`docs/strategy/attunement.md`](docs/strategy/attunement.md).

- **The complete loop is ROADMAP, not a shipped claim** — memory, pattern, proactivity, browser,
  trace and checkpoint are its substrates. First vertical: user-chosen Personal Continuity over
  exact Muse-local artifacts plus optional browser history; Work Resumption is one mode, not the
  product boundary.
- **The Attunement Graph is a rebuildable temporal/provenance projection** and personal context
  compiler; existing stores stay authoritative.

## Trust floor — never traded for a feature

- **Provider/MCP-neutral.** Cloud, self-hosted and local models are all allowed (the rule that
  enforces it is under Non-negotiables).
- **Owner-controlled placement.** `MUSE_LOCAL_ONLY=true` is a strict opt-in posture that refuses
  cloud egress in code, not in a prompt.
- **Deterministic grounding.** Supported grounded personal-data paths cite sources, lower weak
  matches and drop invalid citations. Never claim universal citation coverage or fabrication=0 —
  fast uncited chat is a documented gap. Keep the per-surface grounding ratchets intact.
- **Correction and draft-first action.** The user can contradict Muse; nothing reaches a third
  party without their confirmation of the exact content.
- **Observe stays controllable** — visible, pausable, inspectable, forgettable; never persists raw
  keystrokes or continuous screen capture by default.

## Dev cycle (inner loop)

```bash
pnpm --filter @muse/<name> build       # one package
pnpm typecheck:fast                    # TypeScript 7 project graph, no test fan-out
pnpm test:changed                      # DEFAULT per-edit gate — only tests related to git-changed files
pnpm --filter @muse/<name> test        # one whole package (only when a change is broad)
pnpm --filter @muse/web test:browser   # real Chromium; required for React interaction/focus/keyboard
pnpm check                             # build + test every workspace — pre-commit gate, not per-edit
pnpm smoke:broad                       # broad HTTP smoke, diagnostic provider (no key)
pnpm smoke:live                        # real LLM round-trip — LOCAL OLLAMA ONLY, gemma4:12b default
pnpm lint                              # 0 errors / 0 warnings required
```

These commands are the ground truth; if one fails, stop and triage. Run the narrowest gate that
exposes your change. Tests are the only form of verification a claim can rest on, and `smoke:broad`
(diagnostic) is the start, not the finish — any request/response-path change needs `smoke:live`.

TypeScript/toolchain work follows [`docs/development/typescript-7.md`](docs/development/typescript-7.md):
builds use TS7, the `typescript` dependency stays the TS6 compiler-API alias for tooling, and
migration diagnostics are never masked with compiler-option relaxations.

**Deciding what to do next:** `improve-muse` for HARDENING (regression → failures → live pain probe
→ debt → subtraction), `grow-muse` for a NEW capability (owner's direction → dogfood friction →
north-star gap → parity). One slice end-to-end; "nothing to do" is forbidden.

## How to work — scope, delegation, effort, length

- Deliver what was asked, at the scope intended. Make routine judgment calls yourself; check in only
  when different readings lead to materially different work. If a request seems mistaken, say so in
  a sentence and continue as asked — never quietly narrow, widen or transform it. Finish the whole
  task; stop short of what is clearly beyond it.
- Stop and surface to the owner: destructive actions, scope changes, decisions that are his to make.
- **Opus 5** — delegate only large, genuinely independent, parallelizable tracks; never for work a
  handful of tool calls finishes; never a subagent to verify your own output; prefer one over several.
  Effort: `low`/`medium` liberally wherever quality holds, `xhigh` only for the most demanding work.
- **Fable 5** — delegate freely and keep subagents long-lived across subtasks. Effort: `high` is the
  everyday setting; `xhigh` for the hardest tasks.
- Keep responses concise. Written documents match length to what the task needs — no filler
  sections, redundant summaries or boilerplate.

## Non-negotiables

- `agent-core` is model-agnostic; provider SDKs live behind `packages/model` adapters only. Never
  make OpenAI / Anthropic / Vercel-AI-SDK / LangGraph the runtime owner.
- Guards are fail-close. Hooks are fail-open. Security is deterministic code, never prompt text.
- Tool output is untrusted; tool loops have explicit limits and timeouts.
- Risky local execution flows through `crates/runner`; every surface shares one `agent-core` runtime.
- Outbound to a third party (send, submit, book, post) is fail-close and draft-first per
  [`outbound-safety.md`](.claude/rules/outbound-safety.md) — never an autonomous send. Banking /
  brokerage access and money movement are permanently out of scope.
- No force-push, `--no-verify`, tags/releases, remote-ref deletion, or alternate remote/refspec
  without explicit approval; verified normal pushes follow the standing authorization in
  [`commits.md`](.claude/rules/commits.md). Never commit live workspace credentials.
- All documentation is English — every `.md`, new ones included (quoted UI strings excepted).

## Read further under `.claude/rules/` (loaded on demand, not duplicated here)

[`architecture.md`](.claude/rules/architecture.md) package layout + ModelProvider contract ·
[`product-identity.md`](.claude/rules/product-identity.md) what Muse is and is not ·
[`testing.md`](.claude/rules/testing.md) verification gates · [`agent-testing.md`](.claude/rules/agent-testing.md)
evaluating the AGENT (outcomes, `pass^k`) · [`self-eval.md`](.claude/rules/self-eval.md) the scoreboard that
fails closed on a drop · [`tool-calling.md`](.claude/rules/tool-calling.md) one-shot tool choice for the local
model · [`outbound-safety.md`](.claude/rules/outbound-safety.md) the fail-close send gate ·
[`commits.md`](.claude/rules/commits.md) push policy · [`code-style.md`](.claude/rules/code-style.md)
lint/comment policy (the linter owns style) · [`cli-product.md`](.claude/rules/cli-product.md) CLI surface ·
[`codegraph.md`](.claude/rules/codegraph.md) CodeGraph before grep ·
[`harness.md`](.claude/rules/harness.md) multi-step operating harness.

This contract stays under 100 lines — depth goes in `.claude/rules/*.md`, and a recurring owner
correction is absorbed as a rule there. Read the cross-session learning index first:
`~/.claude/projects/-Users-jinan-side-project-Muse/memory/MEMORY.md`. Product brief: [`AGENTS.md`](AGENTS.md).
