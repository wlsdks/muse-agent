import type { MessagingProviderRegistry } from "./registry.js";

/**
 * Structural shape of `@muse/agent-core`'s `ToolApprovalGate`
 * (kept here so `@muse/messaging` needs no agent-core dependency,
 * same duck-type approach as `InboundAgentRunner`). The agent
 * runtime calls this before every tool with a wider `toolCall`;
 * we only read `.name`.
 */
export interface ChannelApprovalGateInput {
  readonly toolCall: { readonly name: string; readonly arguments?: Record<string, unknown> };
  readonly risk: "read" | "write" | "execute";
  readonly userId?: string;
  readonly runId: string;
}

function clip(value: unknown, max = 60): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) {
    return "";
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * A SHORT, channel-safe draft of what the tool would do, so the user
 * sees the content before approving (outbound-safety draft-first), not
 * just a tool name. Deliberately omits bulk/sensitive payloads (e.g. an
 * email body) — the recipient + subject is enough to decide, and the
 * full body shouldn't be echoed back into a chat transcript.
 */
export function summarizeToolDraft(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) {
    return "";
  }
  switch (name) {
    case "email_send":
      return `to ${clip(args["to"], 40)}, subject "${clip(args["subject"], 50)}"`;
    case "web_action":
      return `${clip(args["method"] ?? "POST", 8)} ${clip(args["url"], 60)}`;
    case "home_action":
      return args["entity"] ? `${clip(args["service"], 40)} on ${clip(args["entity"], 40)}` : clip(args["service"], 40);
    default: {
      const parts = Object.entries(args)
        .filter(([, v]) => v !== undefined && v !== null && typeof v !== "object")
        .slice(0, 3)
        .map(([k, v]) => `${k}=${clip(v, 30)}`);
      return parts.join(", ");
    }
  }
}

export interface ChannelApprovalGateDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export type ChannelApprovalGate = (
  input: ChannelApprovalGateInput
) => Promise<ChannelApprovalGateDecision>;

/**
 * A risky tool the gate refused — handed to `recordRefusal` so the
 * caller can log it (outbound-safety: a refused action must leave a
 * rationale-bearing trail). The gate stays free of any action-log
 * dependency; the caller owns where this is recorded.
 */
export interface ChannelApprovalRefusal {
  readonly tool: string;
  readonly risk: "write" | "execute";
  readonly draft: string;
  /** The tool's arguments — kept so a later approval can re-run it. */
  readonly arguments: Record<string, unknown>;
  readonly userId?: string;
}

/**
 * Approval gate for tools triggered by an inbound channel message.
 * `read` tools pass untouched. A `write` / `execute` (risky) tool
 * is NOT executed: an in-chat approval prompt is posted back to the
 * originating channel and the gate denies this turn. Fail-closed —
 * if posting the prompt throws, the risky tool is still denied
 * (never let it through because the notice failed to send).
 *
 * When `recordRefusal` is supplied, each refused risky tool is handed
 * to it (fail-soft — a throwing recorder never flips the deny), so the
 * action log shows what the agent was blocked on per outbound-safety.
 */
export function createChannelApprovalGate(options: {
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly source: string;
  readonly recordRefusal?: (refusal: ChannelApprovalRefusal) => Promise<void>;
  /**
   * Conversation scope (see `conversation-scope.ts`). Omitted / "direct"
   * keeps today's draft-first approval-prompt flow. "shared" (a
   * group/channel chat) denies OUTRIGHT with a different notice — no
   * approval round-trip is offered, because any member of that chat
   * could "yes" it, not just the paired owner.
   */
  readonly scope?: "direct" | "shared";
}): ChannelApprovalGate {
  return async ({ toolCall, risk, userId }) => {
    if (risk === "read") {
      return { allowed: true };
    }
    const draft = summarizeToolDraft(toolCall.name, toolCall.arguments);
    if (options.recordRefusal) {
      try {
        await options.recordRefusal({ arguments: toolCall.arguments ?? {}, draft, risk, tool: toolCall.name, ...(userId ? { userId } : {}) });
      } catch {
        // Recording the refusal must never change the fail-closed
        // decision — a wedged disk can't let a risky tool through.
      }
    }
    const isShared = options.scope === "shared";
    const text = isShared
      ? `🔒 Muse wanted to run "${toolCall.name}" (${risk})`
        + (draft ? ` — ${draft}` : "")
        + ". Write/execute actions are not available in group chats — this was NOT executed. Ask Muse directly in your 1:1 chat if you want this done."
      : `🔒 Muse wanted to run "${toolCall.name}" (${risk})`
        + (draft ? ` — ${draft}` : "")
        + ". It was NOT executed — Muse won't run a state-changing action from a chat message on its own. It needs your explicit approval and has been logged for your review.";
    try {
      await options.registry.send(options.providerId, { destination: options.source, text });
    } catch {
      // Notice failed to send — still deny; a risky tool must never
      // run just because the approval prompt couldn't be delivered.
    }
    return {
      allowed: false,
      reason: isShared
        ? `write/execute tool "${toolCall.name}" (${risk}) is unavailable in a group chat`
        : `awaiting in-chat approval for "${toolCall.name}" (${risk})`
    };
  };
}
