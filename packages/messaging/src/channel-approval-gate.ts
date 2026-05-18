import type { MessagingProviderRegistry } from "./registry.js";

/**
 * Structural shape of `@muse/agent-core`'s `ToolApprovalGate`
 * (kept here so `@muse/messaging` needs no agent-core dependency,
 * same duck-type approach as `InboundAgentRunner`). The agent
 * runtime calls this before every tool with a wider `toolCall`;
 * we only read `.name`.
 */
export interface ChannelApprovalGateInput {
  readonly toolCall: { readonly name: string };
  readonly risk: "read" | "write" | "execute";
  readonly userId?: string;
  readonly runId: string;
}

export interface ChannelApprovalGateDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export type ChannelApprovalGate = (
  input: ChannelApprovalGateInput
) => Promise<ChannelApprovalGateDecision>;

/**
 * Approval gate for tools triggered by an inbound channel message.
 * `read` tools pass untouched. A `write` / `execute` (risky) tool
 * is NOT executed: an in-chat approval prompt is posted back to the
 * originating channel and the gate denies this turn. Fail-closed —
 * if posting the prompt throws, the risky tool is still denied
 * (never let it through because the notice failed to send).
 */
export function createChannelApprovalGate(options: {
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly source: string;
}): ChannelApprovalGate {
  return async ({ toolCall, risk }) => {
    if (risk === "read") {
      return { allowed: true };
    }
    const text =
      `🔒 Approval needed: Muse wants to run "${toolCall.name}" (${risk}). `
      + "It was NOT executed — reply to approve before it can run.";
    try {
      await options.registry.send(options.providerId, { destination: options.source, text });
    } catch {
      // Notice failed to send — still deny; a risky tool must never
      // run just because the approval prompt couldn't be delivered.
    }
    return {
      allowed: false,
      reason: `awaiting in-chat approval for "${toolCall.name}" (${risk})`
    };
  };
}
