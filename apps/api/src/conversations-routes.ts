/**
 * `/api/conversations` — the web Chats panel's read (+ resume-pointer) view
 * onto the SAME `FileConversationStore` the CLI/web/Telegram/Matrix chat
 * paths already share (S3b, `chat-conversation-continuity.ts`). Read-only:
 * this route never deletes or renames — the CLI owns those verbs. The list
 * route omits turns entirely (summaries only); the detail route caps turns
 * to `CONVERSATION_DETAIL_TURN_CAP` so a very long history never balloons a
 * single response — this is a RENDER cap, distinct from the store's own
 * `MAX_TURNS_PER_CONVERSATION` persistence cap.
 */

import type { Conversation, FileConversationStore } from "@muse/stores";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-auth-helpers.js";
import type { ServerOptions } from "./server-options.js";

export const CONVERSATION_DETAIL_TURN_CAP = 100;

export interface ConversationsRoutesOptions {
  readonly authService?: ServerOptions["authService"];
  readonly conversationStore: FileConversationStore;
}

function capTurns(conversation: Conversation): Conversation {
  return conversation.turns.length > CONVERSATION_DETAIL_TURN_CAP
    ? { ...conversation, turns: conversation.turns.slice(conversation.turns.length - CONVERSATION_DETAIL_TURN_CAP) }
    : conversation;
}

export function registerConversationsRoutes(server: FastifyInstance, options: ConversationsRoutesOptions): void {
  const authEnabled = Boolean(options.authService);

  server.get("/api/conversations", async (request, reply) => {
    if (!requireAuthenticated(request, reply, authEnabled)) {
      return reply;
    }
    const conversations = await options.conversationStore.list();
    return { conversations };
  });

  server.get("/api/conversations/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, authEnabled)) {
      return reply;
    }
    const { id } = request.params as { id: string };
    const conversation = await options.conversationStore.get(id);
    if (!conversation) {
      return reply.status(404).send({ reason: `no conversation "${id}"` });
    }
    return capTurns(conversation);
  });
}
