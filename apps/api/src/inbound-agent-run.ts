import {
  parseBoolean,
  resolveActionLogFile,
  resolveContactsFile,
  resolvePendingApprovalsFile,
  type MuseEnvironment
} from "@muse/autoconfigure";
import { runActuatorByName } from "@muse/domain-tools";
import {
  createChannelApprovalGate,
  type ChannelApprovalGate,
  type MessagingProviderRegistry,
  type ThreadedAgentRun,
  type ThreadTurn
} from "@muse/messaging";
import { gateChatAnswerGrounding } from "@muse/recall";
import type { JsonObject } from "@muse/shared";
import { queryContacts } from "@muse/stores";

import { adoptChannelOwner, parseAllowedChats, readChannelOwner, resolveChannelOwnersFile } from "./channel-owner-store.js";
import { createChannelPendingRecorder } from "./channel-pending-recorder.js";
import { createChannelRefusalRecorder } from "./channel-refusal-recorder.js";
import { handleInboundApprovalReply } from "./inbound-approval-handler.js";

/**
 * Structural slice of AgentRuntime.run — `apps/api` wires the real runtime in;
 * tests substitute a fake without pulling agent-core's full input type.
 */
interface InboundAgentRuntime {
  run(input: {
    readonly messages: readonly ThreadTurn[];
    readonly metadata: { readonly userId: string };
    readonly model: string;
    readonly toolApprovalGate: ChannelApprovalGate;
  }): Promise<{
    readonly response?: { readonly output?: string };
    readonly groundingSources?: readonly { readonly source: string; readonly text: string }[];
  }>;
}

export interface InboundAgentRunOptions {
  readonly agentRuntime: InboundAgentRuntime;
  readonly env: MuseEnvironment;
  readonly model: string;
  readonly registry: MessagingProviderRegistry;
}

/**
 * The channel conversational turn: answer a not-yet-handled inbound message by
 * running the full agent and returning the reply for the originating channel.
 * Extracted from `buildServer` so the production path itself is testable.
 *
 * Two gates guard the turn:
 *  - `createChannelApprovalGate` fail-closes risky tools (draft-first,
 *    outbound-safety.md) and records the refusal for `muse approvals`.
 *  - `gateChatAnswerGrounding` applies the SAME deterministic grounding +
 *    citation gate as the API /chat surface, so a fabricated citation is
 *    dropped by code before the reply leaves for the channel.
 */
const UNPAIRED_CHAT_NOTICE =
  "This bot is a private personal assistant and only talks to its paired owner.";

export function createInboundAgentRun(options: InboundAgentRunOptions): ThreadedAgentRun {
  const { agentRuntime, env, model, registry } = options;
  return async ({ messages, providerId, source }) => {
    // Pairing gate FIRST — a public bot handle is discoverable by
    // anyone, so an un-paired chat is refused deterministically before
    // any approval handling or agent turn can touch personal state.
    const ownersFile = resolveChannelOwnersFile(env);
    const owner = (await readChannelOwner(ownersFile, providerId))
      ?? (await adoptChannelOwner(ownersFile, providerId, source));
    if (source !== owner && !parseAllowedChats(env.MUSE_CHANNEL_ALLOWED_CHATS).has(`${providerId}:${source}`)) {
      return UNPAIRED_CHAT_NOTICE;
    }
    // A bare "yes" approving a pending channel refusal gets a
    // deterministic ack pointing at `muse approvals approve` rather
    // than a confused agent turn on the word "yes".
    const latestUserText = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const approvalAck = await handleInboundApprovalReply({
      pendingFile: resolvePendingApprovalsFile(env),
      providerId,
      source,
      text: latestUserText,
      // Opt-in (default off): an inbound "yes" re-runs the pending
      // tool in-chat. The reply is the explicit confirm of the draft
      // the gate already posted, so the re-run uses an auto-approve
      // gate. Off by default, so completion stays on the deliberate
      // CLI confirm unless the user turns this on.
      ...(parseBoolean(env.MUSE_INBOUND_AUTO_APPROVE, false)
        ? {
            autoRun: (entry) => runActuatorByName(entry.tool, entry.arguments as JsonObject, {
              actionLogFile: resolveActionLogFile(env),
              contacts: () => queryContacts(resolveContactsFile(env)),
              emailApprovalGate: () => ({ approved: true }),
              ...(env.MUSE_GMAIL_TOKEN?.trim() ? { gmailToken: env.MUSE_GMAIL_TOKEN.trim() } : {}),
              ...(env.MUSE_HOMEASSISTANT_URL?.trim() ? { homeAssistantBaseUrl: env.MUSE_HOMEASSISTANT_URL.trim() } : {}),
              ...(env.MUSE_HOMEASSISTANT_TOKEN?.trim() ? { homeAssistantToken: env.MUSE_HOMEASSISTANT_TOKEN.trim() } : {}),
              userId: `${providerId}:${source}`,
              webApprovalGate: () => ({ approved: true })
            })
          }
        : {})
    });
    if (approvalAck !== undefined) {
      return approvalAck;
    }
    const result = await agentRuntime.run({
      messages,
      // The channel identity is the user-memory scope for this
      // chat, so the auto-extract hook grows the knows-you model
      // from channel conversations (without a userId the hook
      // no-ops — a channel chat that never learns the user).
      metadata: { userId: `${providerId}:${source}` },
      model,
      toolApprovalGate: createChannelApprovalGate({
        providerId,
        recordRefusal: async (refusal) => {
          // Both the audit log and the pending worklist must capture
          // the refusal; run them independently so one failing store
          // doesn't drop the other (the gate's deny holds regardless).
          const logIt = createChannelRefusalRecorder({ actionLogFile: resolveActionLogFile(env), providerId, source });
          const queueIt = createChannelPendingRecorder({ pendingFile: resolvePendingApprovalsFile(env), providerId, source });
          await Promise.allSettled([logIt(refusal), queueIt(refusal)]);
        },
        registry,
        source
      })
    });
    const rawOutput = result.response?.output ?? "";
    if (rawOutput.length === 0) {
      return rawOutput;
    }
    // Grounding parity with the /chat surface: gate the raw agent output
    // before it leaves for the channel, so a fabricated/uncited claim is
    // dropped by code (fabrication=0) while a properly grounded answer
    // passes UNCHANGED.
    const gate = gateChatAnswerGrounding({
      answer: rawOutput,
      evidence: [...(result.groundingSources ?? [])],
      question: latestUserText
    });
    return gate.answer;
  };
}
