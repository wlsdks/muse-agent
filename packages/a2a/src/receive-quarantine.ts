/**
 * The inbound glue: classify a received A2A message through the safety core and,
 * when it's accepted know-how, deposit it into quarantine. The store itself is
 * INJECTED (`deposit`) so this stays in `@muse/a2a` without depending on the
 * persistence layer (`@muse/mcp`). A rejected message deposits NOTHING and is
 * never executed.
 */

import { randomUUID } from "node:crypto";

import type { A2APayloadKind, InboundDecision } from "@muse/agent-core";

import type { PeerRegistry } from "./peer-registry.js";
import { receiveFromPeer, type A2AEnv } from "./transport.js";

export interface QuarantineDepositInput {
  readonly id: string;
  readonly kind: A2APayloadKind;
  readonly content: string;
  readonly fromPeerId: string;
  readonly receivedAtMs: number;
  readonly label?: string;
}

export interface ReceiveAndQuarantineOptions {
  readonly env: A2AEnv;
  readonly rawBody: string;
  readonly signature: string | undefined;
  readonly registry: PeerRegistry;
  /** Injected persistence (e.g. `@muse/mcp` addToQuarantine bound to the sidecar file). */
  readonly deposit: (input: QuarantineDepositInput) => Promise<void>;
  readonly now?: () => number;
  readonly genId?: () => string;
}

export async function receiveAndQuarantine(options: ReceiveAndQuarantineOptions): Promise<InboundDecision> {
  const decision = receiveFromPeer({
    env: options.env,
    rawBody: options.rawBody,
    registry: options.registry,
    signature: options.signature
  });
  if (decision.disposition === "quarantine" && decision.envelope) {
    const envelope = decision.envelope;
    await options.deposit({
      content: envelope.content,
      fromPeerId: envelope.fromPeerId,
      id: options.genId?.() ?? randomUUID(),
      kind: envelope.kind,
      receivedAtMs: options.now?.() ?? Date.now(),
      ...(envelope.label !== undefined ? { label: envelope.label } : {})
    });
  }
  return decision;
}
