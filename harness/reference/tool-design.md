---
title: Tool Design Contract
audience: [developers, AI agents]
purpose: How to design and expose tools so the agent picks the right tool and fills its arguments in one shot
status: draft
updated: 2026-06-13
sources_basis: [host .claude (e.g. Muse)/rules/tool-calling.md, Anthropic building-effective-agents (ACI), Anthropic multi-agent research system (tool descriptions), awesome-harness-engineering (tool design category)]
related: [../core/team-roles.md, ../core/verification-and-guardrails.md, architecture.md, ../README.md]
---

# Tool Design Contract

> **Why was this a missing slot?** In the [architecture](architecture.md) self-assessment,
> "tool design" was a ⬜ gap. However good the harness's roles and handoffs, it collapses **if
> the agent can't pick the tool in one shot**. For a host running a small local model (e.g.
> Muse) this is especially existential — organized from the host's (e.g. Muse's) tool contract
> (`tool-calling.md`) together with verified 2026 principles. Prose only (tool-description
> examples in quoted form only).

## 0. The one-line principle

**Design so the FIRST tool call is correct.** A small model gets slower and less accurate with
each extra reasoning round, so don't leave it to "think its way there" — make it **pick the
right tool and fill the arguments in one shot**.

## 1. Expose few (≤ 5–7 per turn)

- Keep the number of tools shown to the model at once small — more tools raise the
  wrong-selection probability.
- Don't dump the whole tool set; expose **only what fits the request context** (relevance
  filter).
- If many are needed, **split by context** instead of widening one prompt.

## 2. Unambiguous names (verb_noun, one job)

- Like `home_state` · `web_action` · `knowledge_search` — **verb_noun, one tool one job**.
- Never ship two tools the model could confuse (no `find`+`search`, no `remove`+`delete`
  together).
- **Homonyms in names/descriptions are the #1 cause of wrong selection.**

## 3. A rich, constrained input schema

- **Always declare `required`** — never lean on optionals for mandatory data.
- Explicit types, `enum` for fixed choices, min/max/pattern for ranges.
- Every property description carries a **concrete example** — "target identifier, e.g.
  `lock.front_door`", not "the entity".
- No abbreviations (`product_name`, not `pn`). "Invalid arguments" is the second-biggest error
  and is stopped here.

## 4. The description says "when to use / when not"

- Put a one-line **"use when … ; do not use for …"** in the tool description.
- It prevents eager invocation on greetings/intent-free input and sharpens selection.

## 5. One tool per response (unless genuinely multi-step)

- Don't design flows that make a small model chain 3+ tools.
- Let one tool finish one job, or split the steps across turns.

## 5.5 Design the response side too (tool-output token budget)

**Responses occupy context** just like input schemas — what and how much a tool returns is also
part of the contract:

- Give every query tool **pagination, range, filter, and truncation defaults** (reference:
  Claude Code's default tool-response cap is 25K tokens).
- When truncating, **return guidance on what to narrow next** along with it — no silent
  truncation (same principle as the runtime `expose`'s dropped report).
- Use a **verbosity enum** like `response_format: concise|detailed`, and **meaningful
  identifiers** (semantic IDs) instead of UUIDs — so the model can reuse results in the next
  call.
- As tools multiply, don't inline every definition; use **progressive disclosure read on
  demand** — exposing tools as a code API/search target measured a 98.7% reduction in
  definition tokens (Anthropic code-execution-with-MCP).

## 6. Risk tier + gate (part of tool design)

- Classify every tool as **read / write / execute** (risk taxonomy).
- State-changing tools pass the gates of
  [verification-and-guardrails](../core/verification-and-guardrails.md) (read passes /
  execute needs the trustlist / denylist refused; outbound is draft-first).

## 7. Validate in code (no re-reasoning loops)

- **Parse and validate tool arguments in code** against the schema; on invalid input, repair or
  re-request deterministically, at most once.
- Never let the model burn rounds guessing the shape — the schema + parser are the contract.

## 8. When adding a tool (checklist)

1. A non-overlapping verb_noun name.
2. Few `required` params + an example and the tightest type/enum/range per property.
3. A one-line "use when / not when".
4. The correct risk tier (read/write/execute); state changes fail-close.
5. Verify **the model actually selects it** — not a handler unit test but a round-trip that
   confirms real selection (golden prompt → expected tool, including negative and confusable
   cases). Absorbed into the golden tasks of [harness-acceptance](harness-acceptance.md).

## One-line summary (tool-design checklist)

1. Are **≤ 5–7 tools** visible per turn?
2. Are names **verb_noun, one job**, with no confusable pairs?
3. Is the schema `required` + **example-bearing**?
4. Does the description say **when to use / when not**?
5. Are risk tiers + gates in place?
6. Is "**the model picks it on the first try**" verified by a golden task?

---

## Runtime component (code)

The contract above as deterministic code: [runner/tools.mjs](../runner/tools.mjs) (zero
dependencies). The model picks and fills tools; the code deterministically enforces
**registration, schema validation, allow/deny, few-exposed, risk tiers**.

- `register(tool)` — `name` must be **verb_noun** (regex-enforced), duplicates rejected;
  `description` and `inputSchema` required; `risk` is one of read/write/execute/outbound/
  forbidden. Invalid declarations rejected (fail-closed).
- `validateArgs(name, args)` — returns missing-required/type/enum/min-max as **actionable
  errors** (Anthropic "actionable errors") — the deterministic validate-and-repair contract.
- `isAllowed(name)` — **denylist beats allowlist**; empty allowlist = all allowed (opt-in, MCP
  registry norm).
- `expose(names?)` — exposes only up to `maxExposed` (default 7) and **reports the dropped
  count** (few-exposed, no silent truncation).
- `riskOf(name)` — passes a tool's risk tier to the
  [permission-matrix](../core/permission-matrix.md) gate/hooks.

Verification: [runner/tools.test.mjs](../runner/tools.test.mjs) —
`node --test "harness/runner/*.test.mjs"`: registration rejection · denylist precedence · empty
allowlist=all · validateArgs (required/type/enum/range) · expose cap+dropped · risk-tier
permission-gate composition. **6/6** (runner suite cumulative **56/56**).

## Sources (verified basis)

- Host rules (e.g. Muse) — `../../.claude/rules/safety/tool-calling.md` (small-model one-shot selection: ≤5–7 exposed · verb_noun · example-bearing schemas · use-when/not-when · code validation)
- Anthropic — [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) (ACI: design tool interfaces to HCI standards)
- Anthropic — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (tool descriptions steer behavior — bad descriptions send agents astray)
- [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering) (tool design category)
- Anthropic — [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (response token budget · pagination/truncation + follow-up guidance · response_format · semantic IDs) · [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) (progressive disclosure — 98.7% definition-token reduction)
