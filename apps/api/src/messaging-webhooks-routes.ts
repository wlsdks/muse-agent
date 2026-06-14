/**
 * Messaging webhook receivers (Phase 2.b.2 of
 * `docs/design/line-webhook.md`). Currently houses the LINE handler;
 * Telegram / Discord / Slack push variants would land here too if we
 * ever want webhook-mode for them (Phase 2.a's REST `fetchInbound`
 * covers them well enough today).
 *
 * Encapsulated as a Fastify plugin so the buffer-mode JSON parser
 * is scoped to this route only — the rest of `/api/*` keeps its
 * default JSON parsing.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  appendInbound,
  type InboundMessage
} from "@muse/messaging";
import type { FastifyPluginAsync } from "fastify";

const LINE_BODY_KEY = "__museRawBody";

interface LineWebhookEvent {
  readonly type?: string;
  readonly timestamp?: number;
  readonly source?: { readonly userId?: string; readonly groupId?: string; readonly roomId?: string };
  readonly message?: { readonly id?: string; readonly type?: string; readonly text?: string };
}

interface LineWebhookBody {
  readonly destination?: string;
  readonly events?: readonly LineWebhookEvent[];
}

export interface LineWebhookOptions {
  readonly channelSecret: string;
  readonly inboxFile: string;
  readonly capacity?: number;
}

export const lineWebhookPlugin: FastifyPluginAsync<LineWebhookOptions> = async (instance, opts) => {
  // Buffer-mode parser scoped to this plugin so signature verification
  // sees the bytes LINE actually sent. Default JSON parsing on the
  // outer instance is unchanged — this only affects routes inside
  // this plugin.
  instance.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body: string, done) => {
      // Stash the raw string so the route handler can run HMAC-SHA256
      // over the exact bytes. JSON.parse for the typed body.
      (request as unknown as Record<string, unknown>)[LINE_BODY_KEY] = body;
      try {
        done(null, body.length === 0 ? {} : (JSON.parse(body) as unknown));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  instance.post("/api/messaging/webhooks/line", async (request, reply) => {
    const raw = (request as unknown as Record<string, unknown>)[LINE_BODY_KEY];
    if (typeof raw !== "string") {
      return reply.status(400).send({ code: "MESSAGING_WEBHOOK_NO_BODY", message: "raw body unavailable" });
    }
    const headerSig = request.headers["x-line-signature"];
    if (typeof headerSig !== "string" || headerSig.length === 0) {
      return reply.status(401).send({ code: "MESSAGING_WEBHOOK_UNSIGNED", message: "missing X-Line-Signature" });
    }
    const expected = createHmac("sha256", opts.channelSecret).update(raw).digest("base64");
    if (!safeEquals(expected, headerSig)) {
      return reply.status(401).send({ code: "MESSAGING_WEBHOOK_BAD_SIGNATURE", message: "signature mismatch" });
    }
    const body = request.body as LineWebhookBody | null;
    const events = body?.events ?? [];
    let stored = 0;
    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text" || typeof event.message.text !== "string") {
        continue;
      }
      const inbound = mapToInbound(event);
      if (!inbound) {
        continue;
      }
      try {
        await appendInbound(opts.inboxFile, inbound, opts.capacity !== undefined ? { capacity: opts.capacity } : {});
        stored += 1;
      } catch (cause) {
        request.log.warn(
          `messaging-webhook: failed to persist line message ${inbound.messageId}: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      }
    }
    // LINE retries non-2xx for ~30 minutes — always 200 once signature
    // matches, even if persistence partially failed (we logged it).
    return reply.status(200).send({ events: events.length, stored });
  });
};

function mapToInbound(event: LineWebhookEvent): InboundMessage | undefined {
  const messageId = event.message?.id;
  const text = event.message?.text;
  if (!messageId || typeof text !== "string") {
    return undefined;
  }
  const source = event.source?.userId ?? event.source?.groupId ?? event.source?.roomId ?? "";
  if (source.length === 0) {
    return undefined;
  }
  const ts = typeof event.timestamp === "number" ? new Date(event.timestamp) : new Date();
  return {
    messageId,
    providerId: "line",
    raw: event,
    receivedAtIso: Number.isNaN(ts.getTime()) ? new Date().toISOString() : ts.toISOString(),
    ...(event.source?.userId ? { sender: event.source.userId } : {}),
    source,
    text
  };
}

function safeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
