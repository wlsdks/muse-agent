import { errorMessage, redactSecretsInText } from "@muse/shared";

import {
  acquireOutboundEffectDispatch,
  computeOutboundEffectPayloadHash,
  readOutboundEffect,
  recordOutboundEffectAccepted,
  recordOutboundEffectUnknown,
  type OutboundEffectView
} from "./outbound-effect-store.js";
import type { MessagingProviderRegistry } from "./registry.js";

const MAX_UNKNOWN_DETAIL = 1_000;

export class OutboundEffectDispatchUncertainError extends Error {
  readonly effectId: string;

  constructor(effectId: string, message: string) {
    super(message);
    this.effectId = effectId;
    this.name = "OutboundEffectDispatchUncertainError";
  }
}

export interface DispatchOutboundEffectOnceOptions {
  readonly effectFile: string;
  readonly effectId: string;
  readonly registry: Pick<MessagingProviderRegistry, "send">;
  readonly providerId: string;
  readonly destination: string;
  readonly text: string;
  readonly now?: () => Date;
}

export interface DispatchDurableEffectOnceOptions {
  readonly effectFile: string;
  readonly effectId: string;
  readonly providerId: string;
  readonly destination: string;
  readonly payloadHash: string;
  /**
   * One provider attempt for the already-snapshotted payload. A non-empty,
   * exact provider message id is the only proof that the effect was accepted.
   */
  readonly dispatch: () => Promise<{
    readonly messageId: string | undefined;
    readonly providerId?: string;
    readonly destination?: string;
  }>;
  readonly now?: () => Date;
}

/**
 * Make at most one provider call for one durable effect identity.
 *
 * Existing `prepared` state is deliberately treated as ambiguous: it may be a
 * crash after the provider accepted but before Muse persisted the receipt.
 * Replays seal it as `unknown` and never call the provider again.
 */
export async function dispatchOutboundEffectOnce(
  options: DispatchOutboundEffectOnceOptions
): Promise<OutboundEffectView> {
  const now = options.now ?? (() => new Date());
  const wireText = redactSecretsInText(options.text);
  const stable = {
    destination: options.destination,
    effectFile: options.effectFile,
    effectId: options.effectId,
    now,
    providerId: options.providerId,
    send: options.registry.send.bind(options.registry),
    text: wireText
  } as const;
  return dispatchDurableEffectOnce({
    destination: stable.destination,
    dispatch: () =>
      stable.send(stable.providerId, {
        destination: stable.destination,
        idempotencyKey: stable.effectId,
        text: stable.text
      }),
    effectFile: stable.effectFile,
    effectId: stable.effectId,
    now: stable.now,
    payloadHash: computeOutboundEffectPayloadHash({
      destination: stable.destination,
      providerId: stable.providerId,
      text: stable.text
    }),
    providerId: stable.providerId
  });
}

/**
 * Provider-neutral durable at-most-once primitive. It deliberately knows
 * nothing about the payload: the caller snapshots and hashes the exact bytes
 * approved for its domain, then supplies one provider attempt.
 */
export async function dispatchDurableEffectOnce(
  options: DispatchDurableEffectOnceOptions
): Promise<OutboundEffectView> {
  const now = options.now ?? (() => new Date());
  const stable = {
    destination: options.destination,
    dispatch: options.dispatch,
    effectFile: options.effectFile,
    effectId: options.effectId,
    now,
    payloadHash: options.payloadHash,
    providerId: options.providerId
  } as const;
  const acquiredAt = canonicalNow(stable.now);
  const acquisition = await acquireOutboundEffectDispatch(
    stable.effectFile,
    {
      destination: stable.destination,
      effectId: stable.effectId,
      payloadHash: stable.payloadHash,
      providerId: stable.providerId
    },
    acquiredAt
  );

  if (!acquisition.acquired) {
    if (acquisition.effect.state !== "prepared") return acquisition.effect;
    return sealUnknown(
      stable.effectFile,
      stable.effectId,
      "restart replay found a durable prepared effect; prior delivery is not provable",
      monotonicNow(stable.now, acquisition.effect.binding.createdAt)
    );
  }

  let receipt: Awaited<ReturnType<DispatchDurableEffectOnceOptions["dispatch"]>>;
  try {
    receipt = await stable.dispatch();
  } catch (cause) {
    return sealUnknown(
      stable.effectFile,
      stable.effectId,
      `provider dispatch did not return a receipt: ${safeDetail(cause)}`,
      monotonicNow(stable.now, acquisition.effect.binding.createdAt)
    );
  }
  if (
    typeof receipt.messageId !== "string"
    || receipt.messageId.length === 0
    || receipt.messageId !== receipt.messageId.trim()
  ) {
    return sealUnknown(
      stable.effectFile,
      stable.effectId,
      "provider dispatch returned without a non-empty exact message id",
      monotonicNow(stable.now, acquisition.effect.binding.createdAt)
    );
  }

  const recordedAt = monotonicNow(stable.now, acquisition.effect.binding.createdAt);
  try {
    return await recordOutboundEffectAccepted(
      stable.effectFile,
      stable.effectId,
      {
        destination: receipt.destination ?? stable.destination,
        messageId: receipt.messageId,
        providerId: receipt.providerId ?? stable.providerId,
        receivedAt: recordedAt
      },
      recordedAt
    );
  } catch (cause) {
    return sealUnknown(
      stable.effectFile,
      stable.effectId,
      `provider returned a receipt but durable acceptance failed: ${safeDetail(cause)}`,
      recordedAt
    );
  }
}

async function sealUnknown(
  file: string,
  effectId: string,
  detail: string,
  recordedAt: string
): Promise<OutboundEffectView> {
  try {
    return await recordOutboundEffectUnknown(file, effectId, detail, recordedAt);
  } catch (cause) {
    let current: OutboundEffectView | undefined;
    try {
      current = await readOutboundEffect(file, effectId);
    } catch (readCause) {
      throw new OutboundEffectDispatchUncertainError(
        effectId,
        `outbound effect ${effectId} is safely blocked, but neither its unknown receipt nor current state could be read: ` +
        `${safeDetail(cause)}; reread: ${safeDetail(readCause)}`
      );
    }
    if (current && current.state !== "prepared") return current;
    throw new OutboundEffectDispatchUncertainError(
      effectId,
      `outbound effect ${effectId} is safely blocked in prepared state, but its unknown receipt could not be persisted: ${safeDetail(cause)}`
    );
  }
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) throw new Error("outbound effect clock returned an invalid date");
  return value.toISOString();
}

function monotonicNow(now: () => Date, earliest: string): string {
  const current = canonicalNow(now);
  return Date.parse(current) < Date.parse(earliest) ? earliest : current;
}

function safeDetail(cause: unknown): string {
  return redactSecretsInText(errorMessage(cause)).slice(0, MAX_UNKNOWN_DETAIL);
}
