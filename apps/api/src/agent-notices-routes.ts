/**
 * `GET /api/agent-notices/stream?userId=<id>` — SSE consumer for
 * agent-initiated notices.
 *
 * Companion to the in-process `AgentInitiatedNoticeBroker` exposed
 * on the runtime assembly. Producers (the proactive-notice loop)
 * publish synthesised one-line responses; this endpoint fans them
 * out to whatever client (CLI subscriber, web UI) is holding the SSE
 * connection open for the given `userId`.
 *
 * Lifecycle:
 *   1. Client GETs with `userId=<id>`.
 *   2. Route subscribes to the broker for that userId.
 *   3. Each publish yields `event: notice\ndata: <json>\n\n`.
 *   4. Client disconnect or HTTP close → unsubscribe (cleanup).
 *
 * Multiple clients for the same userId are independent subscribers —
 * each receives every notice (this is intentional; a user with two
 * surfaces open should see the notice in both).
 */

import type { AgentInitiatedNotice, AgentInitiatedNoticeBroker } from "@muse/agent-core";
import type { FastifyInstance } from "fastify";
import { EventEmitter, on as waitForEvent } from "node:events";
import { Readable } from "node:stream";

import { readQueryString } from "./compat-parsers.js";
import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

interface AgentNoticesRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly agentInitiatedNoticeBroker: AgentInitiatedNoticeBroker;
}

export function registerAgentNoticesRoutes(
  server: FastifyInstance,
  gate: AgentNoticesRoutesGate
): void {
  server.get("/api/agent-notices/stream", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const userId = readQueryString(request, "userId");
    if (!userId) {
      return reply.status(400).send({
        code: "USER_ID_REQUIRED",
        message: "agent-notices/stream requires a `userId` query parameter"
      });
    }

    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    reply.header("x-accel-buffering", "no");

    return reply.send(Readable.from(streamNoticesFor(gate.agentInitiatedNoticeBroker, userId, request.raw)));
  });
}

/** Exported for direct test coverage of the unsubscribe lifecycle. */
export async function* streamNoticesFor(
  broker: AgentInitiatedNoticeBroker,
  userId: string,
  socket: { once(event: "close", listener: () => void): void }
): AsyncIterable<string> {
  const queue: AgentInitiatedNotice[] = [];
  let closed = false;
  const wakeup = new EventEmitter();
  const wakeupNotifications = waitForEvent(wakeup, "wakeup");

  const onClose = () => {
    closed = true;
    wakeup.emit("wakeup");
  };
  socket.once("close", onClose);

  const unsubscribe = broker.subscribe(userId, (notice) => {
    queue.push(notice);
    wakeup.emit("wakeup");
  });

  try {
    // The open frame is inside the try so an early consumer
    // disconnect (generator .return() while suspended here, before
    // the loop) still runs `finally` — otherwise the broker
    // subscription + its unbounded queue leak forever.
    //
    // One-shot `event: open` so clients can synchronise on the
    // subscription becoming live before the first publish; without
    // it a producer firing immediately after the route opens can
    // race the consumer's listener registration.
    yield `event: open\ndata: ${JSON.stringify({ userId })}\n\n`;

    while (!closed) {
      if (queue.length === 0) {
        await wakeupNotifications.next();
        continue;
      }
      const next = queue.shift();
      if (!next) continue;
      yield `event: notice\ndata: ${JSON.stringify(next)}\n\n`;
    }
  } finally {
    unsubscribe();
    void wakeupNotifications.return?.();
  }
}
