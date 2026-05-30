/**
 * A2A peer-to-peer transport — HTTP between Muse instances, every message routed
 * through the deterministic safety core (`@muse/agent-core` a2a-safety):
 *
 *   send:    isA2AEnabled → prepareOutbound (refuse non-know-how, redact PII)
 *            → sign → POST to the peer's URL.
 *   receive: isA2AEnabled → parse → verify HMAC against the CLAIMED peer's secret
 *            → classifyInbound (quarantine | reject — NEVER execute).
 *
 * The transport adds NO new authority: it cannot send anything `prepareOutbound`
 * refuses, and it cannot do anything with an inbound message except hand back a
 * quarantine/reject decision. A peer can never trigger compute here.
 */

import {
  A2ASafetyError,
  classifyInbound,
  isA2AEnabled,
  prepareOutbound,
  type A2AEnvelope,
  type A2AOutbound,
  type InboundDecision
} from "@muse/agent-core";

import type { A2APeer, PeerRegistry } from "./peer-registry.js";
import { signEnvelope, verifySignature } from "./signing.js";

export const A2A_SIGNATURE_HEADER = "x-muse-a2a-signature";

export interface A2AEnv {
  readonly MUSE_A2A_ENABLED?: string | undefined;
}

export interface SendToPeerOptions {
  readonly env: A2AEnv;
  readonly peer: A2APeer;
  readonly outbound: A2AOutbound;
  readonly fromPeerId: string;
  readonly fetchImpl?: typeof fetch;
  readonly redact?: (text: string) => string;
}

export interface SendResult {
  readonly ok: boolean;
  readonly status: number;
  readonly envelope: A2AEnvelope;
}

/**
 * Send know-how to a peer. Throws `A2ASafetyError` (sends NOTHING) when A2A is
 * disabled or the payload isn't shareable know-how; redacts PII before the
 * content can leave; signs with the peer's shared secret.
 */
export async function sendToPeer(options: SendToPeerOptions): Promise<SendResult> {
  if (!isA2AEnabled(options.env)) {
    throw new A2ASafetyError("A2A is disabled — set MUSE_A2A_ENABLED to opt into the swarm.");
  }
  // prepareOutbound is the gate: a non-know-how kind throws here, before any send.
  const envelope = prepareOutbound(options.outbound, options.fromPeerId, options.redact);
  const signature = signEnvelope(envelope, options.peer.secret);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.peer.url, {
    body: JSON.stringify(envelope),
    headers: {
      "content-type": "application/json",
      [A2A_SIGNATURE_HEADER]: signature
    },
    method: "POST"
  });
  return { envelope, ok: response.ok, status: response.status };
}

export interface ReceiveFromPeerOptions {
  readonly env: A2AEnv;
  readonly rawBody: string;
  readonly signature: string | undefined;
  readonly registry: PeerRegistry;
}

/**
 * Classify an inbound HTTP message. Verifies the HMAC against the claimed peer's
 * secret, then defers to the safety core. Returns ONLY quarantine | reject — the
 * caller can never be told to execute anything.
 */
export function receiveFromPeer(options: ReceiveFromPeerOptions): InboundDecision {
  if (!isA2AEnabled(options.env)) {
    return { disposition: "reject", reason: "A2A is disabled on this Muse" };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(options.rawBody) as unknown;
  } catch {
    return { disposition: "reject", reason: "unparseable A2A body" };
  }
  const fromPeerId = (envelope as { fromPeerId?: unknown }).fromPeerId;
  const peer = typeof fromPeerId === "string" ? options.registry.get(fromPeerId) : undefined;
  if (!peer) {
    return { disposition: "reject", reason: `unknown peer '${String(fromPeerId)}' — not in the allowlist` };
  }
  if (!options.signature || !verifySignature(envelope as A2AEnvelope, options.signature, peer.secret)) {
    return { disposition: "reject", reason: "invalid signature — envelope tampered or wrong secret" };
  }
  // The safety core has the final say: quarantine | reject, never execute.
  return classifyInbound(envelope, options.registry.allowedIds());
}
