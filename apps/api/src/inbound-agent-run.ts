import { casualResponseFor, classifyCasualPrompt, classifyChannelIntent, containsHangul, guardAgainstUnbackedActionClaim } from "@muse/agent-core";
import {
  parseBoolean,
  resolveActionLogFile,
  resolveContactsFile,
  resolveLastProactiveDeliveryFile,
  resolvePendingApprovalsFile,
  type MuseEnvironment
} from "@muse/autoconfigure";
import { runActuatorByName } from "@muse/domain-tools";
import type { UserMemoryStore } from "@muse/memory";
import {
  createChannelApprovalGate,
  effectiveScope,
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
import { loadChatPersonaSnapshot } from "./chat-persona-snapshot.js";
import { handleInboundApprovalReply } from "./inbound-approval-handler.js";
import { handleInboundVetoReply } from "./inbound-veto-handler.js";
import { resolveProactiveTrustFile } from "./tick-daemons.js";

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
    readonly toolsUsed?: readonly string[];
  }>;
}

export interface InboundAgentRunOptions {
  readonly agentRuntime: InboundAgentRuntime;
  readonly env: MuseEnvironment;
  readonly model: string;
  readonly registry: MessagingProviderRegistry;
  /**
   * Delegation-ack composer (S2, `MUSE_CHANNEL_ACK`). Optional — a caller
   * that omits it simply never sends an ack, same as the flag being off.
   */
  readonly composeAck?: (input: { readonly latestUserText: string }) => Promise<string | null>;
  /**
   * Conversational fast-path composer (S3, `MUSE_CHANNEL_CHAT`). Answers a
   * message `classifyChannelIntent` reads as pure smalltalk with ONE
   * single-inference reply instead of the full agent run. Optional — a
   * caller that omits it simply never takes the fast path, same as the flag
   * being off. Fail-open: a `null` return (or a throw) falls through to the
   * normal ack + full-run path, which is the safety net.
   */
  readonly composeChatReply?: (input: {
    readonly latestUserText: string;
    readonly thread: readonly ThreadTurn[];
    readonly personaSnapshot?: readonly { readonly source: string; readonly text: string }[];
  }) => Promise<string | null>;
  /**
   * Backs the chat fast-path's "knows-you" snapshot (`loadChatPersonaSnapshot`).
   * Optional — a caller that omits it simply never personalizes the fast path
   * (the branch behaves exactly as before: no snapshot, empty evidence).
   */
  readonly userMemoryStore?: UserMemoryStore;
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
  const { agentRuntime, composeAck, composeChatReply, env, model, registry, userMemoryStore } = options;
  return async ({ messages, providerId, source, scope: rawScope, notify }) => {
    // Conversation-scope capability profile (P7-3, the sequel to TOFU
    // pairing): a group/shared chat gets a STRICTLY narrower posture than
    // a 1:1 — never TOFU-adopted as owner, never the owner's memory scope,
    // never a risky-tool approval round-trip a random group member could
    // "yes". `effectiveScope` fails closed — absent/unknown scope is
    // "shared", never silently the safer-looking "direct".
    const scope = effectiveScope(rawScope);
    const ownersFile = resolveChannelOwnersFile(env);
    if (scope === "shared") {
      // NEVER adopt a group/channel chat as the TOFU owner — that would
      // let the first random group message claim ownership of the agent.
      const groupAllowed = parseBoolean(env.MUSE_CHANNEL_GROUP_ENABLED, false)
        && parseAllowedChats(env.MUSE_CHANNEL_ALLOWED_CHATS).has(`${providerId}:${source}`);
      if (!groupAllowed) {
        return UNPAIRED_CHAT_NOTICE;
      }
    } else {
      // Pairing gate — a public bot handle is discoverable by anyone, so
      // an un-paired 1:1 chat is refused deterministically before any
      // approval handling or agent turn can touch personal state.
      const owner = (await readChannelOwner(ownersFile, providerId))
        ?? (await adoptChannelOwner(ownersFile, providerId, source));
      if (source !== owner && !parseAllowedChats(env.MUSE_CHANNEL_ALLOWED_CHATS).has(`${providerId}:${source}`)) {
        return UNPAIRED_CHAT_NOTICE;
      }
    }
    const latestUserText = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    // Approval-reply hijack guard: a pending approval is 1:1-scoped state
    // (outbound-safety — only the paired owner may confirm a draft), so a
    // "yes" from a group/shared chat must NEVER be interpreted as a
    // confirmation, even if a pending entry happens to exist for this
    // providerId+source. Skipping the lookup entirely (rather than
    // filtering results) makes the hijack path structurally impossible.
    const approvalAck = scope === "shared"
      ? undefined
      : await handleInboundApprovalReply({
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
    // Channel-veto reply ("그만"/"stop these"): the one-touch off-switch for
    // proactivity. Owner 1:1 only — a shared/group chat's "그만" must never
    // silence the owner's own notices, so this is skipped entirely for
    // scope==="shared" (same posture as the approval-reply hijack guard
    // above, for the same reason: shared-chat state must never mutate
    // 1:1-scoped learned avoidance).
    const vetoAck = scope === "shared"
      ? undefined
      : await handleInboundVetoReply({
          lastDeliveryFile: resolveLastProactiveDeliveryFile(env),
          now: new Date(),
          text: latestUserText,
          trustLedgerFile: resolveProactiveTrustFile(env)
        });
    if (vetoAck !== undefined) {
      return vetoAck;
    }
    // Deterministic casual fast-path (parity with `muse ask`): a bare
    // greeting/thanks/farewell is not a question about the user's notes, so
    // answer it conversationally and skip the agent run + grounding gate
    // entirely — nothing here is a factual claim that needs a citation.
    const casualKind = classifyCasualPrompt(latestUserText);
    if (casualKind) {
      return casualResponseFor(casualKind, containsHangul(latestUserText));
    }
    // Conversational fast-path (S3, completing the assistant rhythm): a
    // message `classifyChannelIntent` reads as pure smalltalk — a kind of
    // turn `classifyCasualPrompt` above does NOT cover (it only matches a
    // bare greeting/thanks/farewell) — gets ONE single-inference reply
    // instead of the full ~1min agent pipeline. TRIPLE-GATED and
    // conservative BY DESIGN (classifyChannelIntent defaults to
    // "delegation" — see chat-intent.ts): a chat message misrouted to
    // delegation only costs latency (the ack + full run below still answers
    // it correctly), so this branch fails open at every step — a `null`
    // reply, a throw, or the flag being off all fall through unchanged to
    // the ack + full-run path, the safety net.
    if (
      parseBoolean(env.MUSE_CHANNEL_CHAT, true)
      && composeChatReply
      && classifyChannelIntent(latestUserText) === "chat"
    ) {
      // Owner-scope-only "knows-you" snapshot (chat-persona-snapshot.ts): a
      // few bounded, citable lines from the SAME memory scope the auto-
      // extract hook writes (`${providerId}:${source}`). `null` on a
      // shared/group turn, an unavailable store, or a load error all
      // collapse to `[]` here — the fail-open contract this whole branch
      // already runs under (empty snapshot = behaves exactly as before).
      const personaSnapshot = (await loadChatPersonaSnapshot({ providerId, scope, source, userMemoryStore }).catch(() => null)) ?? [];
      const chatReply = await composeChatReply({ latestUserText, personaSnapshot, thread: messages }).catch(() => null);
      if (chatReply !== null) {
        // Run the SAME gate the full agent path applies below
        // (gateChatAnswerGrounding), now against REAL evidence — the persona
        // snapshot just loaded — instead of an empty list. What this buys:
        // the citation-validity check and the reported grounding verdict now
        // have a real referent (a citation naming something OUTSIDE the
        // snapshot is still dropped by code). It is STILL NOT fabrication=0
        // for a plain uncited sentence: `enforceAnswerCitations` only ever
        // inspects CITED text, so an invented fact with no "[from …]" marker
        // at all passes through untouched regardless of the evidence list —
        // that gap is unchanged by adding the snapshot. The anti-fabrication
        // defense for an UNCITED claim stays upstream: `createComposeChatReply`'s
        // no-facts system prompt (now told exactly which snapshot lines it
        // MAY draw on), the "PASS" sentinel for a genuine ask, and
        // `classifyChannelIntent`'s conservative default.
        const chatGate = gateChatAnswerGrounding({ answer: chatReply, evidence: personaSnapshot, question: latestUserText });
        return chatGate.answer;
      }
    }
    // Delegation ack (S2, "the assistant rhythm"): a non-casual request is a
    // delegation, so restate it as an early second-channel confirmation
    // BEFORE the (possibly slow) agent run, then stay quiet until the real
    // answer. Cosmetic — sequential (same local model box, no parallel
    // inference) and any failure here must never affect the run below.
    if (parseBoolean(env.MUSE_CHANNEL_ACK, true) && composeAck && notify) {
      // Fail-open: a composer error/timeout/rejection means no ack, never a
      // failed run — `composeAck` itself already fails open, but a caller's
      // implementation is not trusted to.
      const ack = await composeAck({ latestUserText }).catch(() => null);
      if (ack !== null) {
        // Ack delivery is cosmetic — a failed send must never fail the run.
        await notify(ack).catch(() => undefined);
      }
    }
    const result = await agentRuntime.run({
      messages,
      // The channel identity is the user-memory scope for this chat, so
      // the auto-extract hook grows the knows-you model from channel
      // conversations. A SHARED chat gets a DISTINCT scope
      // (`{providerId}:shared:{source}`), never the owner's own
      // `{providerId}:{source}` id: personal facts must never inject into
      // a group turn, and group chatter must never pollute the owner's
      // user model.
      metadata: { userId: scope === "shared" ? `${providerId}:shared:${source}` : `${providerId}:${source}` },
      model,
      toolApprovalGate: createChannelApprovalGate({
        providerId,
        recordRefusal: async (refusal) => {
          // The audit log always captures the refusal (outbound-safety:
          // every action, sent OR refused, leaves a trail). The
          // re-runnable PENDING-approval queue is 1:1 only — queuing it
          // for a shared chat would make a group "yes" a viable re-run
          // path, defeating the outright-deny above.
          const logIt = createChannelRefusalRecorder({ actionLogFile: resolveActionLogFile(env), providerId, source });
          if (scope === "shared") {
            await logIt(refusal);
            return;
          }
          const queueIt = createChannelPendingRecorder({ pendingFile: resolvePendingApprovalsFile(env), providerId, source });
          await Promise.allSettled([logIt(refusal), queueIt(refusal)]);
        },
        registry,
        scope,
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
    // Honest-action gate (parity with the API /chat surface —
    // `honest-action-guard.ts`): a channel reply can CLAIM a completed
    // state-changing action ("일정을 등록했습니다") while no actuator tool ran.
    // No retry here — a Telegram/Matrix turn already left the runtime, so
    // (like the streamed /chat final frame) this is a deterministic
    // downgrade only.
    const honest = await guardAgainstUnbackedActionClaim({
      firstResult: { response: { output: gate.answer }, toolsUsed: result.toolsUsed ?? [] },
      query: latestUserText
    });
    return honest.response.output;
  };
}
