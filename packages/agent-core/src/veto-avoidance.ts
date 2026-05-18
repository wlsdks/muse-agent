import { appendSystemSection, metadataString } from "./runtime-helpers.js";
import type { AgentRunContext, AgentRunInput, Awaitable } from "./types.js";

/**
 * One thing the user has corrected Muse on. Duck-typed so
 * `agent-core` stays free of a `@muse/mcp` dependency — the API
 * server adapts the real veto store to this shape.
 */
export interface LearnedVeto {
  readonly scope: string;
  readonly objectiveId?: string;
  readonly reason?: string;
}

export interface VetoAvoidanceProvider {
  listVetoes(userId: string): Awaitable<readonly LearnedVeto[]>;
}

function sanitizeInline(value: string): string {
  // Veto reasons are user-authored free text; collapse whitespace
  // so a `\n[System Override]\n` splice cannot forge a section.
  return value.replace(/\s+/gu, " ").trim();
}

export function renderVetoAvoidanceSection(vetoes: readonly LearnedVeto[]): string | undefined {
  if (vetoes.length === 0) {
    return undefined;
  }
  const lines = [
    "[Learned Avoidance]",
    "The user has previously corrected you on the following. Do NOT",
    "propose or take these actions again unless the user explicitly",
    "asks for them this turn:"
  ];
  for (const veto of vetoes) {
    const where = veto.objectiveId ? ` (objective ${sanitizeInline(veto.objectiveId)})` : "";
    const why = veto.reason ? ` — ${sanitizeInline(veto.reason)}` : "";
    lines.push(`- ${sanitizeInline(veto.scope)}${where}${why}`);
  }
  return lines.join("\n");
}

/**
 * Surface the user's recorded vetoes as a `[Learned Avoidance]`
 * system block so the agent stops PROPOSING a corrected action
 * class everywhere — not only at the consented-action gate.
 *
 * Conservative + opt-out-safe: no provider, no `metadata.userId`,
 * or zero vetoes ⇒ the input is returned unchanged (an
 * un-corrected user / smoke:live is unaffected). Fail-open: a
 * throwing provider degrades to no-op — a correction surface must
 * never break a run.
 */
export async function applyVetoAvoidance(
  context: AgentRunContext,
  provider: VetoAvoidanceProvider | undefined
): Promise<AgentRunInput> {
  if (!provider) {
    return context.input;
  }
  const userId = metadataString(context.input.metadata, "userId");
  if (!userId) {
    return context.input;
  }
  let vetoes: readonly LearnedVeto[];
  try {
    vetoes = await provider.listVetoes(userId);
  } catch {
    return context.input;
  }
  const rendered = renderVetoAvoidanceSection(vetoes);
  if (!rendered) {
    return context.input;
  }
  return {
    ...context.input,
    messages: appendSystemSection(context.input.messages, rendered, "veto-avoidance"),
    metadata: { ...context.input.metadata, vetoAvoidanceApplied: true }
  };
}
