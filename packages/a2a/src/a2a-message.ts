/**
 * Map Muse's flat know-how envelope onto the A2A v1.0 wire vocabulary and back.
 *
 * On the wire a know-how share is a standard A2A JSON-RPC `message/send` request
 * whose Message carries the redacted envelope as a `DataPart` (so a real A2A
 * client can parse it). But the FLAT envelope stays the canonical form that gets
 * HMAC-signed and classified — the safety core never depends on parsing full
 * A2A JSON-RPC, and peer-supplied `metadata` is never trusted for policy
 * decisions (only the signed envelope fields are).
 */

import type { A2AEnvelope } from "@muse/agent-core";
import { isRecord } from "@muse/shared";

import { KNOW_HOW_ONLY_EXT_URI } from "./agent-card.js";

export interface A2ADataPart {
  readonly kind: "data";
  readonly data: A2AEnvelope;
  readonly metadata?: Record<string, unknown>;
}

export interface A2AMessage {
  readonly kind: "message";
  readonly role: "agent" | "user";
  readonly messageId: string;
  readonly parts: readonly A2ADataPart[];
}

export interface A2ASendRequest {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: "message/send";
  readonly params: { readonly message: A2AMessage };
}

/** Wrap a signed envelope as an A2A Message (one DataPart). */
export function envelopeToA2AMessage(envelope: A2AEnvelope, messageId: string): A2AMessage {
  return {
    kind: "message",
    messageId,
    parts: [{
      data: envelope,
      kind: "data",
      metadata: {
        "muse:ext": KNOW_HOW_ONLY_EXT_URI,
        "muse:payloadKind": envelope.kind,
        "muse:redacted": envelope.redacted
      }
    }],
    role: "agent"
  };
}

/** Frame the message as a standard A2A JSON-RPC `message/send` request. */
export function envelopeToSendRequest(envelope: A2AEnvelope, messageId: string, rpcId: string): A2ASendRequest {
  return {
    id: rpcId,
    jsonrpc: "2.0",
    method: "message/send",
    params: { message: envelopeToA2AMessage(envelope, messageId) }
  };
}

/**
 * Pull the candidate flat envelope out of an inbound A2A body — a JSON-RPC
 * `message/send` request, OR a bare Message. Returns the first DataPart's
 * `data` (an UNTRUSTED candidate validated downstream by HMAC + classifyInbound)
 * or null. Reads only the canonical `data`, never the peer's metadata.
 */
export function extractEnvelopeFromA2ABody(body: unknown): unknown {
  if (!body || typeof body !== "object") return null;
  const bodyRecord = isRecord(body) ? body : {};
  const message = isRecord(bodyRecord.params) ? bodyRecord.params.message : body;
  const messageRecord = isRecord(message) ? message : {};
  const parts = messageRecord.parts;
  if (!Array.isArray(parts)) return null;
  const dataPart = parts.find(
    (p): p is A2ADataPart => isRecord(p) && p.kind === "data" && p.data !== undefined && typeof p.data === "object"
  );
  return dataPart ? dataPart.data : null;
}
