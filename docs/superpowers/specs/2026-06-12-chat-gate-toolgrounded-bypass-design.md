# Chat gate: narrow the `toolGrounded` blanket bypass to real evidence

**Date:** 2026-06-12
**Bug:** 2026-06-10 full-feature audit, CLI #4 — "toolGrounded blanket bypass"
**Surface:** `apps/cli/src/chat-grounding.ts` `finalizeGatedChatAnswer`

## Problem

`finalizeGatedChatAnswer` is the ONE post-stream pipeline every chat surface
runs (gate → citation strips → receipt). Today it decides whether to gate by:

```ts
const toolGrounded = (args.toolsUsed ?? []).length > 0;
const gated = toolGrounded ? args.answer : /* full gate */;
```

When *any* tool was invoked, the answer is returned **ungated** — both the
deterministic value checks (wrong number / email / IP / identifier) **and** the
semantic coverage gate are skipped. Two holes:

1. **Empty-result tool still bypasses.** A tool that ran but returned nothing
   (a failed search, an actuator with no read output) leaves `toolsUsed`
   non-empty, so a fabricated answer riding alongside that empty call skips the
   floor entirely. The bypass is keyed on *tool was called*, not *tool produced
   evidence*.
2. **Value checks die with the bypass.** Even a genuinely tool-answered
   personal-fact recall loses the always-on number/email guard, so a wrong value
   the tool did NOT actually return is surfaced.

This is a hole in Muse's core edge (the fabrication=0 grounding floor), reachable
from the conversational surface the desktop companion uses exclusively.

## The available data (two surfaces, two shapes — grill finding)

`AgentRunResult.groundingSources?: { source, text }[]` is exactly the evidence a
read-tool actually produced (`source: toolName`, **omitted when there was none**;
built by `groundingSourcesFromToolResults` = completed status + non-empty output,
capped).

- **chat-repl** uses the non-streaming `agentRuntime.run()` and holds the full
  `result` — `result.groundingSources` is right there. Two-line wire.
- **chat-ink** STREAMS (`agentRuntime.stream()`), and the streamed `tool-result`
  event carries only `{ runId, toolCall, type }` — **not the tool's output**.
  The output lives in the internal `toolResults` that only `run()` maps into
  `groundingSources`. So on the ink surface the evidence is **not reachable**
  without surfacing it on the stream.

Leaving ink unwired would regress it: with `toolGroundingSources` empty, a
genuinely tool-answered personal-fact turn would start abstaining. So the fix
must surface tool grounding on the stream too — both surfaces, one contract (the
"ONE pipeline" must not drift, which is exactly what audit #1 closed).

## Design (Approach A — chosen)

`FinalizeGatedChatAnswerArgs` gains:

```ts
readonly toolGroundingSources?: readonly { readonly source: string; readonly text: string }[];
```

The gate decision becomes:

```ts
const toolEvidence = (args.toolGroundingSources ?? []).map((s) => ({
  cosine: 1, score: 1, source: s.source, text: s.text,
}));
const toolGrounded = toolEvidence.length > 0;             // real evidence, not "a tool ran"
const evidence = [...args.matches, ...conversationMatches(args.history ?? []), ...toolEvidence];

const gated = toolGrounded
  ? gateChatAnswerDeterministic(args.question, args.answer, evidence, args.knownFactKeys ?? [])
  : args.reverify
    ? await gateChatAnswerWithReverify(args.question, args.answer, evidence, args.knownFactKeys ?? [], args.reverify)
    : gateChatAnswer(args.question, args.answer, evidence, args.knownFactKeys ?? []);
```

`gateChatAnswerDeterministic` (new, exported) runs **only** `chatGatePrecheck`:
an `abstain` decision (a wrong number/email/IP/identifier the tool evidence does
not contain) → `chatAbstention`; any other decision → the answer as-is. It does
NOT run the semantic `verifyGrounding` coverage stage, because that rubric scores
note-coverage and would false-refuse a legitimately tool/web-grounded answer
(its tokens are not in the notes corpus). The tool's own `{source,text}` is in
`evidence`, so a value the tool actually returned is supported; a fabricated one
is not.

When tools ran but produced **no** grounding sources (`toolGrounded === false`),
the full normal gate runs — closing hole #1.

### Why not the alternatives

- **B — feed tool sources into `matches` and run the FULL gate (no bypass).**
  More principled, but `verifyGrounding`'s coverage floor is calibrated for
  notes; a web/tool answer scores low coverage against the notes set and gets
  false-refused. Over-refusal of correct tool answers is a regression.
- **C — keep the `toolsUsed.length` bypass, add an always-on value check before
  it.** Fixes hole #2 but not hole #1 (an empty-result tool call still skips the
  semantic gate). Half a fix.

## Behavioral contract (the TDD cases)

| # | Setup | Expected |
|---|---|---|
| 1 | `toolGroundingSources` non-empty; answer asserts a number NOT in the tool evidence or notes; personal-fact-recall question | **abstain** (number check still runs — the core fix) |
| 2 | `toolGroundingSources` carries the value; answer states that value | **pass** (no false refusal of a real tool answer) |
| 3 | `toolsUsed` non-empty but `toolGroundingSources` empty/absent; ungrounded fabrication | **abstain** (full gate runs — hole #1) |
| 4 | non-tool path (no tools, note/conversation grounded) | unchanged (regression guard) |

The existing `chat-finalize.test.ts` case "tool-grounded turns bypass the gate"
currently passes `toolsUsed: ["muse.tasks.list"]` with **no** grounding sources;
under the new contract that would (correctly) start abstaining. It is rewritten
to carry the tool's real output as `toolGroundingSources` — i.e. it becomes
case 2 (a real tool result IS the grounding, and it surfaces).

## Wiring (load-bearing — both surfaces)

**Single source of truth (agent-core).** Extract
`groundingSourceFromExecuted(executed): { source, text } | undefined` (completed
status + non-empty trimmed output + `GROUNDING_SOURCE_TEXT_CAP`) in
`runtime-internals.ts`. `groundingSourcesFromToolResults` (the `run()` path) and
the new stream emission both call it, so "what counts as tool grounding" cannot
diverge between surfaces.

**Stream event (additive, backward-compatible).** The `tool-result` ModelEvent
gains `grounding?: { source: string; text: string }`, computed in `model-loop.ts`
from `executed.result` via the shared helper. Existing consumers (the SSE API
path) ignore the new optional field; `pnpm check` flags any exhaustive switch.

**chat-repl** (`run()` result): pass
`toolGroundingSources: result.groundingSources ?? []`.

**chat-ink** (stream): collect `event.grounding` from `tool-result` events into a
`toolGrounding[]` during the turn loop; pass it as `toolGroundingSources` to
`finalizeAnswer`. The ink `ChatStream` event type gains the optional `grounding`
field (its shape is already loose).

## Residual risk (accepted — out of scope)

A tool-grounded answer that fabricates **prose** (not a number/email/IP/
identifier) — e.g. an invented task title alongside real ones — still passes,
because the semantic coverage stage is skipped for tool-grounded turns. Catching
that reliably needs a judge-vs-tool-evidence pass (`verifyGrounding`'s
whole-answer coverage is too blunt — it already cannot catch one fabricated item
among real ones, per its own code comments), which costs one inference on EVERY
tool chat turn (a latency regression). That is a separate slice. This fix closes
the two REPORTED holes (empty-result bypass + value-checks dying); it does not
weaken any existing check. Recorded in `backlog.md`.

## Scope / non-goals

- agent-core change is limited to: the shared grounding helper + the additive
  `grounding` field on the `tool-result` stream event. No change to the gate's
  value-check internals or `verifyGrounding`.
- No change to the ask path (`commands-ask.ts` already scores against
  `groundingSources` via its own output-side verdict).
- Does not touch the other two audit bugs (corrupt→wipe, embedder migration).

## Verification

1. `pnpm --filter @muse/agent-core test -- <stream-grounding test>` — a completed
   tool's stream `tool-result` carries `grounding`; a failed/empty one does not
   (the shared helper, RED first).
2. `pnpm --filter @muse/cli test -- chat-finalize` — the 4 gate cases (RED first).
3. `pnpm check` (build + all workspaces; type-checks the new field + arg through
   the stream event and both call sites — the exhaustive-switch backstop).
4. `pnpm eval:agent` (or at minimum the chat-grounding battery) — proves the
   live floor did not regress.
5. `pnpm lint`

Grounding floor is **strengthened** (a previously-bypassed surface is now gated);
fabrication=0 invariant is never weakened.
