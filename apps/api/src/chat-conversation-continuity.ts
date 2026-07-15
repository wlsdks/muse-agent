/**
 * Web/API half of the shared conversation store (S3b) — a single-`message`
 * `/api/chat`(`/stream`) body threads through the SAME `FileConversationStore`
 * the CLI's active conversation uses (same default file, same read-side cap
 * via `recentChatTurns` + `CHAT_CONTEXT_TURN_LIMIT` — imported, never
 * reimplemented), so a web chat and a CLI `muse chat -c --resume <id>` can
 * continue the same conversation. An explicit `{messages:[...]}` body
 * bypasses this entirely (compat unchanged, nothing persisted).
 */

import {
  CHAT_CONTEXT_TURN_LIMIT,
  defaultConversationsFile,
  FileConversationStore,
  newConversationId,
  recentChatTurns
} from "@muse/stores";
import { isRecord, redactSecretsInText, withBestEffort } from "@muse/shared";
import type { AgentRunInput } from "@muse/agent-core";

import type { ServerOptions } from "./server.js";

export interface ChatConversationPlan {
  readonly conversationId: string;
  readonly priorMessages: AgentRunInput["messages"];
  /** Fail-soft: a store-write hiccup never turns a successful chat answer into a 500. */
  readonly persistTurn: (answerText: string) => Promise<void>;
}

export function conversationStoreFor(options: ServerOptions): FileConversationStore {
  return new FileConversationStore({ file: options.conversationsFile ?? defaultConversationsFile() });
}

function isSingleMessageChatBody(body: unknown): body is Record<string, unknown> & { readonly message: string } {
  return isRecord(body) && !Array.isArray(body.messages) && typeof body.message === "string";
}

function requestedConversationId(body: Record<string, unknown>): string | undefined {
  const raw = body.conversationId;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * Resolves the conversation continuity plan for a chat body, or `undefined`
 * for the explicit `{messages:[...]}` compat form (which bypasses ALL of
 * this — nothing read, nothing persisted). A corrupt store file or an
 * unknown/garbage `conversationId` both fail-soft to "no prior turns",
 * never a 500 (AC5) — the run just proceeds as a fresh conversation.
 */
export async function resolveChatConversationPlan(
  body: unknown,
  options: ServerOptions
): Promise<ChatConversationPlan | undefined> {
  if (!isSingleMessageChatBody(body)) {
    return undefined;
  }
  const store = conversationStoreFor(options);
  const requestedId = requestedConversationId(body);
  const conversationId = requestedId ?? newConversationId();
  let priorMessages: AgentRunInput["messages"] = [];
    if (requestedId) {
      const conversation = await withBestEffort(store.get(requestedId), undefined);
      priorMessages = recentChatTurns(conversation?.turns ?? [], CHAT_CONTEXT_TURN_LIMIT).map((turn) => ({
        content: turn.content,
        role: turn.role
      }));
    }
  return {
    conversationId,
    persistTurn: async (answerText: string) => {
      try {
        const nowIso = new Date().toISOString();
        await store.appendTurns(
          conversationId,
          [
            { at: nowIso, content: redactSecretsInText(body.message), role: "user" },
            { at: nowIso, content: redactSecretsInText(answerText), role: "assistant" }
          ],
          { origin: "web" }
        );
      } catch {
        /* fail-soft — see persistTurn's doc comment */
      }
    },
    priorMessages
  };
}

/**
 * Splice prior conversation turns between any leading system message(s) and
 * the caller's own message(s). A single-`message` body always parses to
 * `[system?, user]` (`parseAgentRunInput`), so this never has to guess
 * where "prior" ends.
 */
export function withPriorConversationTurns(
  messages: AgentRunInput["messages"],
  priorMessages: AgentRunInput["messages"]
): AgentRunInput["messages"] {
  if (priorMessages.length === 0) {
    return messages;
  }
  const systemMessages = messages.filter((message) => message.role === "system");
  const rest = messages.filter((message) => message.role !== "system");
  return [...systemMessages, ...priorMessages, ...rest];
}
