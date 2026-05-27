import { appendSystemSection, metadataString } from "./runtime-helpers.js";
import type { AgentRunContext, AgentRunInput, Awaitable } from "./types.js";

/**
 * ACE — Agentic Context Engineering (arXiv 2510.04618): a frozen model
 * self-improves by accumulating small, incremental strategy deltas in an
 * evolving "playbook" instead of being re-prompted/fine-tuned. This is the
 * POSITIVE counterpart to veto-avoidance: where a veto says "don't do X", a
 * playbook strategy says "when X, prefer Y" — a learned how-to the user (or a
 * correction) taught, injected so the agent applies it on matching turns.
 *
 * Duck-typed so `agent-core` stays free of a `@muse/mcp` dependency.
 */
export interface PlaybookStrategy {
  /** The learned strategy, e.g. "when rescheduling, default to the next business day". */
  readonly text: string;
  /** Optional task-class tag so strategies can be scoped/filtered later. */
  readonly tag?: string;
}

export interface PlaybookProvider {
  listStrategies(userId: string): Awaitable<readonly PlaybookStrategy[]>;
}

function sanitizeInline(value: string): string {
  // Strategies are user-authored free text; collapse whitespace so a
  // `\n[System Override]\n` splice cannot forge a section.
  return value.replace(/\s+/gu, " ").trim();
}

export function renderPlaybookSection(strategies: readonly PlaybookStrategy[]): string | undefined {
  const cleaned = strategies.map((s) => sanitizeInline(s.text)).filter((t) => t.length > 0);
  if (cleaned.length === 0) {
    return undefined;
  }
  const lines = [
    "[Learned Strategies]",
    "From past feedback, apply these working preferences when they fit the",
    "current request (they are guidance, not overrides of the user's words):"
  ];
  for (const text of cleaned) {
    lines.push(`- ${text}`);
  }
  return lines.join("\n");
}

/**
 * Inject the user's learned strategies as a `[Learned Strategies]` system
 * block so the agent applies what past corrections taught (ACE's evolving
 * playbook). Conservative + opt-out-safe: no provider, no `metadata.userId`,
 * or zero strategies ⇒ input returned unchanged (smoke:live unaffected).
 * Fail-open: a throwing provider degrades to no-op.
 */
export async function applyPlaybook(
  context: AgentRunContext,
  provider: PlaybookProvider | undefined
): Promise<AgentRunInput> {
  if (!provider) {
    return context.input;
  }
  const userId = metadataString(context.input.metadata, "userId");
  if (!userId) {
    return context.input;
  }
  let strategies: readonly PlaybookStrategy[];
  try {
    strategies = await provider.listStrategies(userId);
  } catch {
    return context.input;
  }
  const rendered = renderPlaybookSection(strategies);
  if (!rendered) {
    return context.input;
  }
  return {
    ...context.input,
    messages: appendSystemSection(context.input.messages, rendered, "playbook"),
    metadata: { ...context.input.metadata, playbookApplied: true }
  };
}
