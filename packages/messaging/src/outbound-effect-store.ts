import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { atomicWritePrivateFile, withMessagingFileMutation } from "./messaging-file-store.js";

const SCHEMA_VERSION = "muse.outbound-effect-ledger/v1";
const GENESIS_HASH = "0".repeat(64);
const SHA256_RE = /^[0-9a-f]{64}$/u;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS = 20_000;
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_DETAIL_LENGTH = 2_000;

export class OutboundEffectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundEffectStoreError";
  }
}

export class OutboundEffectBindingConflictError extends OutboundEffectStoreError {
  readonly effectId: string;

  constructor(effectId: string) {
    super(`effect id is already bound to a different payload: ${effectId}`);
    this.effectId = effectId;
    this.name = "OutboundEffectBindingConflictError";
  }
}

export interface OutboundEffectBinding {
  readonly effectId: string;
  readonly providerId: string;
  readonly destination: string;
  readonly payloadHash: string;
  readonly createdAt: string;
}

export type OutboundEffectDispatchBinding = Omit<OutboundEffectBinding, "createdAt">;

export interface OutboundEffectAcquisition {
  readonly acquired: boolean;
  readonly effect: OutboundEffectView;
}

export interface OutboundEffectReceipt {
  readonly providerId: string;
  readonly destination: string;
  readonly messageId: string;
  readonly receivedAt: string;
  /** Digest of an optional raw provider receipt; raw payload is never persisted here. */
  readonly providerReceiptDigest?: string;
}

export type OutboundEffectState =
  | "prepared"
  | "accepted"
  | "unknown"
  | "reconciled-accepted"
  | "reconciled-not-delivered";

export interface OutboundEffectView {
  readonly binding: OutboundEffectBinding;
  readonly state: OutboundEffectState;
  readonly receipt?: OutboundEffectReceipt;
  readonly unknownDetail?: string;
  readonly reconciliation?: {
    readonly actor: string;
    readonly decision: "accepted" | "not-delivered";
    readonly reason: string;
    readonly recordedAt: string;
  };
}

interface EventEnvelope {
  readonly eventId: string;
  readonly previousHash: string;
  readonly hash: string;
}

interface PreparedEvent extends EventEnvelope {
  readonly type: "prepared";
  readonly binding: OutboundEffectBinding;
}

interface AcceptedEvent extends EventEnvelope {
  readonly type: "accepted";
  readonly effectId: string;
  readonly preparedEventId: string;
  readonly receipt: OutboundEffectReceipt;
  readonly recordedAt: string;
}

interface UnknownEvent extends EventEnvelope {
  readonly type: "unknown";
  readonly effectId: string;
  readonly preparedEventId: string;
  readonly detail: string;
  readonly recordedAt: string;
}

interface ReconciledEvent extends EventEnvelope {
  readonly type: "reconciled";
  readonly effectId: string;
  readonly unknownEventId: string;
  readonly actor: string;
  readonly decision: "accepted" | "not-delivered";
  readonly reason: string;
  readonly recordedAt: string;
  readonly receipt?: OutboundEffectReceipt;
}

type OutboundEffectEvent = PreparedEvent | AcceptedEvent | UnknownEvent | ReconciledEvent;

interface OutboundEffectLedger {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly events: readonly OutboundEffectEvent[];
}

interface DerivedEffect {
  readonly view: OutboundEffectView;
  readonly preparedEventId: string;
  readonly unknownEventId?: string;
  readonly terminalEvent?: AcceptedEvent | UnknownEvent | ReconciledEvent;
}

export function computeOutboundEffectPayloadHash(input: {
  readonly providerId: string;
  readonly destination: string;
  readonly text: string;
}): string {
  return sha256(canonicalJson(input));
}

export async function readOutboundEffect(
  file: string,
  effectId: string
): Promise<OutboundEffectView | undefined> {
  return deriveEffects(await readLedgerStrict(file)).get(effectId)?.view;
}

export async function readOutboundEffects(file: string): Promise<readonly OutboundEffectView[]> {
  return [...deriveEffects(await readLedgerStrict(file)).values()].map((entry) => entry.view);
}

export async function prepareOutboundEffect(
  file: string,
  binding: OutboundEffectBinding
): Promise<OutboundEffectView> {
  assertBinding(binding);
  const stableBinding = snapshotBinding(binding);
  return withMessagingFileMutation(file, async () => {
    const ledger = await readLedgerStrict(file);
    const existing = deriveEffects(ledger).get(stableBinding.effectId);
    if (existing) {
      if (canonicalJson(existing.view.binding) !== canonicalJson(stableBinding)) {
        throw new OutboundEffectBindingConflictError(stableBinding.effectId);
      }
      return existing.view;
    }
    const event = createEvent<PreparedEvent>(ledger.events, { binding: stableBinding, type: "prepared" });
    await writeLedger(file, append(ledger, event));
    return { binding: stableBinding, state: "prepared" };
  });
}

/**
 * Atomically grants exactly one caller permission to make the first provider
 * call for an effect. Replays compare the immutable route/payload binding but
 * keep the original createdAt, so a restart cannot manufacture binding drift.
 */
export async function acquireOutboundEffectDispatch(
  file: string,
  binding: OutboundEffectDispatchBinding,
  createdAt: string
): Promise<OutboundEffectAcquisition> {
  assertDispatchBinding(binding);
  assertTimestamp(createdAt, "createdAt");
  const stableBinding = snapshotDispatchBinding(binding);
  return withMessagingFileMutation(file, async () => {
    const ledger = await readLedgerStrict(file);
    const existing = deriveEffects(ledger).get(stableBinding.effectId);
    if (existing) {
      if (!sameDispatchBinding(existing.view.binding, stableBinding)) {
        throw new OutboundEffectBindingConflictError(stableBinding.effectId);
      }
      return { acquired: false, effect: existing.view };
    }
    const preparedBinding = { ...stableBinding, createdAt };
    const event = createEvent<PreparedEvent>(ledger.events, {
      binding: preparedBinding,
      type: "prepared"
    });
    await writeLedger(file, append(ledger, event));
    return {
      acquired: true,
      effect: { binding: preparedBinding, state: "prepared" }
    };
  });
}

export async function recordOutboundEffectAccepted(
  file: string,
  effectId: string,
  receipt: OutboundEffectReceipt,
  recordedAt: string
): Promise<OutboundEffectView> {
  assertExactText(effectId, "effectId");
  assertReceipt(receipt);
  assertTimestamp(recordedAt, "recordedAt");
  const stableReceipt = snapshotReceipt(receipt);
  return withMessagingFileMutation(file, async () => {
    const ledger = await readLedgerStrict(file);
    const existing = requireEffect(ledger, effectId);
    assertReceiptRoute(existing.view.binding, stableReceipt);
    assertAcceptedTimes(existing.view.binding, stableReceipt, recordedAt);
    if (existing.view.state === "accepted") {
      if (canonicalJson(existing.view.receipt) !== canonicalJson(stableReceipt)) {
        throw new OutboundEffectStoreError(`accepted receipt drift for effect: ${effectId}`);
      }
      if (existing.terminalEvent?.type !== "accepted" || existing.terminalEvent.recordedAt !== recordedAt) {
        throw new OutboundEffectStoreError(`accepted timestamp drift for effect: ${effectId}`);
      }
      return existing.view;
    }
    if (existing.view.state !== "prepared") {
      throw new OutboundEffectStoreError(`effect ${effectId} is terminal in state ${existing.view.state}`);
    }
    const event = createEvent<AcceptedEvent>(ledger.events, {
      effectId,
      preparedEventId: existing.preparedEventId,
      receipt: stableReceipt,
      recordedAt,
      type: "accepted"
    });
    await writeLedger(file, append(ledger, event));
    return { binding: existing.view.binding, receipt: stableReceipt, state: "accepted" };
  });
}

export async function recordOutboundEffectUnknown(
  file: string,
  effectId: string,
  detail: string,
  recordedAt: string
): Promise<OutboundEffectView> {
  assertExactText(effectId, "effectId");
  assertBoundedDetail(detail, "detail");
  assertTimestamp(recordedAt, "recordedAt");
  return withMessagingFileMutation(file, async () => {
    const ledger = await readLedgerStrict(file);
    const existing = requireEffect(ledger, effectId);
    assertAtOrAfter(recordedAt, existing.view.binding.createdAt, "unknown.recordedAt");
    if (existing.view.state === "unknown") {
      if (existing.view.unknownDetail !== detail) {
        throw new OutboundEffectStoreError(`unknown detail drift for effect: ${effectId}`);
      }
      if (existing.terminalEvent?.type !== "unknown" || existing.terminalEvent.recordedAt !== recordedAt) {
        throw new OutboundEffectStoreError(`unknown timestamp drift for effect: ${effectId}`);
      }
      return existing.view;
    }
    if (existing.view.state !== "prepared") {
      throw new OutboundEffectStoreError(`effect ${effectId} is terminal in state ${existing.view.state}`);
    }
    const event = createEvent<UnknownEvent>(ledger.events, {
      detail,
      effectId,
      preparedEventId: existing.preparedEventId,
      recordedAt,
      type: "unknown"
    });
    await writeLedger(file, append(ledger, event));
    return { binding: existing.view.binding, state: "unknown", unknownDetail: detail };
  });
}

export async function reconcileOutboundEffect(
  file: string,
  input: {
    readonly effectId: string;
    readonly actor: string;
    readonly decision: "accepted" | "not-delivered";
    readonly reason: string;
    readonly recordedAt: string;
    readonly receipt?: OutboundEffectReceipt;
  }
): Promise<OutboundEffectView> {
  const inputKeys = ["actor", "decision", "effectId", "reason", "recordedAt"];
  if (input.receipt !== undefined) inputKeys.push("receipt");
  if (!isExactObject(input, inputKeys)) {
    throw new OutboundEffectStoreError("manual reconciliation contains unsupported fields");
  }
  if (input.decision !== "accepted" && input.decision !== "not-delivered") {
    throw new OutboundEffectStoreError("manual reconciliation decision is unsupported");
  }
  assertExactText(input.effectId, "effectId");
  assertExactText(input.actor, "actor");
  assertBoundedDetail(input.reason, "reason");
  assertTimestamp(input.recordedAt, "recordedAt");
  if (input.decision === "accepted") {
    if (!input.receipt) throw new OutboundEffectStoreError("accepted reconciliation requires a provider receipt");
    assertReceipt(input.receipt);
  } else if (input.receipt !== undefined) {
    throw new OutboundEffectStoreError("not-delivered reconciliation must not include a provider receipt");
  }
  const stableInput = {
    actor: input.actor,
    decision: input.decision,
    effectId: input.effectId,
    reason: input.reason,
    recordedAt: input.recordedAt,
    ...(input.receipt ? { receipt: snapshotReceipt(input.receipt) } : {})
  } as const;
  return withMessagingFileMutation(file, async () => {
    const ledger = await readLedgerStrict(file);
    const existing = requireEffect(ledger, stableInput.effectId);
    const expectedState = stableInput.decision === "accepted" ? "reconciled-accepted" : "reconciled-not-delivered";
    const reconciliation = {
      actor: stableInput.actor,
      decision: stableInput.decision,
      reason: stableInput.reason,
      recordedAt: stableInput.recordedAt
    } as const;
    if (existing.view.state === expectedState) {
      if (canonicalJson(existing.view.reconciliation) !== canonicalJson(reconciliation)
        || !sameOptionalJson(existing.view.receipt, stableInput.receipt)) {
        throw new OutboundEffectStoreError(`reconciliation drift for effect: ${stableInput.effectId}`);
      }
      return existing.view;
    }
    if (existing.view.state !== "unknown" || !existing.unknownEventId) {
      throw new OutboundEffectStoreError(`effect ${stableInput.effectId} is not awaiting manual reconciliation`);
    }
    if (stableInput.receipt) assertReceiptRoute(existing.view.binding, stableInput.receipt);
    const unknownEvent = existing.terminalEvent;
    if (!unknownEvent || unknownEvent.type !== "unknown") {
      throw new OutboundEffectStoreError(`effect ${stableInput.effectId} has no durable unknown event`);
    }
    assertAtOrAfter(stableInput.recordedAt, unknownEvent.recordedAt, "reconciliation.recordedAt");
    if (stableInput.receipt) assertAcceptedTimes(existing.view.binding, stableInput.receipt, stableInput.recordedAt);
    const event = createEvent<ReconciledEvent>(ledger.events, {
      actor: stableInput.actor,
      decision: stableInput.decision,
      effectId: stableInput.effectId,
      reason: stableInput.reason,
      recordedAt: stableInput.recordedAt,
      ...(stableInput.receipt ? { receipt: stableInput.receipt } : {}),
      type: "reconciled",
      unknownEventId: existing.unknownEventId
    });
    await writeLedger(file, append(ledger, event));
    return {
      binding: existing.view.binding,
      reconciliation,
      ...(stableInput.receipt ? { receipt: stableInput.receipt } : {}),
      state: expectedState
    };
  });
}

async function readLedgerStrict(file: string): Promise<OutboundEffectLedger> {
  let raw: string;
  try {
    const metadata = await fs.lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new OutboundEffectStoreError("outbound effect ledger must be a regular file");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new OutboundEffectStoreError("outbound effect ledger permissions are not private");
    }
    raw = await fs.readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], schemaVersion: SCHEMA_VERSION };
    }
    if (cause instanceof OutboundEffectStoreError) throw cause;
    throw new OutboundEffectStoreError("outbound effect ledger cannot be read");
  }
  if (Buffer.byteLength(raw) > MAX_LEDGER_BYTES) {
    throw new OutboundEffectStoreError("outbound effect ledger exceeds size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new OutboundEffectStoreError("outbound effect ledger is corrupt");
  }
  if (!isExactObject(value, ["events", "schemaVersion"])
    || value["schemaVersion"] !== SCHEMA_VERSION
    || !Array.isArray(value["events"])
    || value["events"].length > MAX_EVENTS) {
    throw new OutboundEffectStoreError("outbound effect ledger has an unsupported schema");
  }
  const events: OutboundEffectEvent[] = [];
  let previousHash = GENESIS_HASH;
  for (const rawEvent of value["events"]) {
    if (!isEvent(rawEvent)
      || rawEvent.previousHash !== previousHash
      || hashEvent(rawEvent) !== rawEvent.hash
      || Buffer.byteLength(canonicalJson(rawEvent)) > MAX_EVENT_BYTES) {
      throw new OutboundEffectStoreError("outbound effect ledger integrity check failed");
    }
    events.push(rawEvent);
    previousHash = rawEvent.hash;
  }
  const ledger = { events, schemaVersion: SCHEMA_VERSION } as const;
  deriveEffects(ledger);
  return ledger;
}

function deriveEffects(ledger: OutboundEffectLedger): Map<string, DerivedEffect> {
  const effects = new Map<string, DerivedEffect>();
  for (const event of ledger.events) {
    if (event.type === "prepared") {
      assertBinding(event.binding);
      if (effects.has(event.binding.effectId)) {
        throw new OutboundEffectStoreError(`duplicate prepared effect: ${event.binding.effectId}`);
      }
      effects.set(event.binding.effectId, {
        preparedEventId: event.eventId,
        view: { binding: event.binding, state: "prepared" }
      });
      continue;
    }
    if (event.type === "reconciled") {
      const existing = effects.get(event.effectId);
      if (!existing
        || existing.view.state !== "unknown"
        || existing.unknownEventId !== event.unknownEventId
        || existing.terminalEvent?.type !== "unknown") {
        throw new OutboundEffectStoreError(`invalid reconciliation transition for effect: ${event.effectId}`);
      }
      if (event.receipt) assertReceiptRoute(existing.view.binding, event.receipt);
      const unknownEvent = existing.terminalEvent;
      if (!unknownEvent || unknownEvent.type !== "unknown") {
        throw new OutboundEffectStoreError(`invalid reconciliation source for effect: ${event.effectId}`);
      }
      assertAtOrAfter(event.recordedAt, unknownEvent.recordedAt, "reconciliation.recordedAt");
      if (event.receipt) assertAcceptedTimes(existing.view.binding, event.receipt, event.recordedAt);
      effects.set(event.effectId, {
        ...existing,
        terminalEvent: event,
        view: {
          binding: existing.view.binding,
          reconciliation: {
            actor: event.actor,
            decision: event.decision,
            reason: event.reason,
            recordedAt: event.recordedAt
          },
          ...(event.receipt ? { receipt: event.receipt } : {}),
          state: event.decision === "accepted" ? "reconciled-accepted" : "reconciled-not-delivered"
        }
      });
      continue;
    }
    const existing = effects.get(event.effectId);
    if (!existing || event.preparedEventId !== existing.preparedEventId || existing.terminalEvent) {
      throw new OutboundEffectStoreError(`invalid terminal transition for effect: ${event.effectId}`);
    }
    if (event.type === "accepted") {
      assertReceiptRoute(existing.view.binding, event.receipt);
      assertAcceptedTimes(existing.view.binding, event.receipt, event.recordedAt);
      effects.set(event.effectId, {
        ...existing,
        terminalEvent: event,
        view: { binding: existing.view.binding, receipt: event.receipt, state: "accepted" }
      });
      continue;
    }
    if (event.type === "unknown") {
      assertAtOrAfter(event.recordedAt, existing.view.binding.createdAt, "unknown.recordedAt");
      effects.set(event.effectId, {
        ...existing,
        terminalEvent: event,
        unknownEventId: event.eventId,
        view: { binding: existing.view.binding, state: "unknown", unknownDetail: event.detail }
      });
      continue;
    }
  }
  return effects;
}

function createEvent<T extends OutboundEffectEvent>(
  events: readonly OutboundEffectEvent[],
  body: Omit<T, keyof EventEnvelope>
): T {
  const previousHash = events.at(-1)?.hash ?? GENESIS_HASH;
  const eventId = sha256(canonicalJson({ ...body, previousHash, purpose: "event-id" }));
  const withoutHash = { ...body, eventId, previousHash };
  const event = { ...withoutHash, hash: sha256(canonicalJson(withoutHash)) } as T;
  if (Buffer.byteLength(canonicalJson(event)) > MAX_EVENT_BYTES) {
    throw new OutboundEffectStoreError("outbound effect event exceeds size limit");
  }
  return event;
}

function append(ledger: OutboundEffectLedger, event: OutboundEffectEvent): OutboundEffectLedger {
  if (ledger.events.length >= MAX_EVENTS) throw new OutboundEffectStoreError("outbound effect ledger is full");
  return { events: [...ledger.events, event], schemaVersion: SCHEMA_VERSION };
}

async function writeLedger(file: string, ledger: OutboundEffectLedger): Promise<void> {
  const serialized = `${JSON.stringify(ledger, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_LEDGER_BYTES) {
    throw new OutboundEffectStoreError("outbound effect ledger exceeds size limit");
  }
  await atomicWritePrivateFile(file, serialized);
}

function requireEffect(ledger: OutboundEffectLedger, effectId: string): DerivedEffect {
  const effect = deriveEffects(ledger).get(effectId);
  if (!effect) throw new OutboundEffectStoreError(`outbound effect not found: ${effectId}`);
  return effect;
}

function assertBinding(value: OutboundEffectBinding): void {
  if (!isExactObject(value, ["createdAt", "destination", "effectId", "payloadHash", "providerId"])) {
    throw new OutboundEffectStoreError("outbound effect binding contains unsupported fields");
  }
  assertExactText(value.effectId, "effectId");
  assertExactText(value.providerId, "providerId");
  assertExactText(value.destination, "destination");
  if (!SHA256_RE.test(value.payloadHash)) throw new OutboundEffectStoreError("payloadHash must be lowercase SHA-256");
  assertTimestamp(value.createdAt, "createdAt");
}

function assertDispatchBinding(value: OutboundEffectDispatchBinding): void {
  if (!isExactObject(value, ["destination", "effectId", "payloadHash", "providerId"])) {
    throw new OutboundEffectStoreError("outbound effect dispatch binding contains unsupported fields");
  }
  assertExactText(value.effectId, "effectId");
  assertExactText(value.providerId, "providerId");
  assertExactText(value.destination, "destination");
  if (!SHA256_RE.test(value.payloadHash)) throw new OutboundEffectStoreError("payloadHash must be lowercase SHA-256");
}

function snapshotBinding(value: OutboundEffectBinding): OutboundEffectBinding {
  return {
    createdAt: value.createdAt,
    destination: value.destination,
    effectId: value.effectId,
    payloadHash: value.payloadHash,
    providerId: value.providerId
  };
}

function snapshotDispatchBinding(value: OutboundEffectDispatchBinding): OutboundEffectDispatchBinding {
  return {
    destination: value.destination,
    effectId: value.effectId,
    payloadHash: value.payloadHash,
    providerId: value.providerId
  };
}

function sameDispatchBinding(
  existing: OutboundEffectBinding,
  requested: OutboundEffectDispatchBinding
): boolean {
  return existing.effectId === requested.effectId
    && existing.providerId === requested.providerId
    && existing.destination === requested.destination
    && existing.payloadHash === requested.payloadHash;
}

function assertReceipt(value: OutboundEffectReceipt): void {
  const keys = ["destination", "messageId", "providerId", "receivedAt"];
  if (value.providerReceiptDigest !== undefined) keys.push("providerReceiptDigest");
  if (!isExactObject(value, keys)) {
    throw new OutboundEffectStoreError("provider receipt contains unsupported fields");
  }
  assertExactText(value.providerId, "receipt.providerId");
  assertExactText(value.destination, "receipt.destination");
  assertExactText(value.messageId, "receipt.messageId");
  assertTimestamp(value.receivedAt, "receipt.receivedAt");
  if (value.providerReceiptDigest !== undefined && !SHA256_RE.test(value.providerReceiptDigest)) {
    throw new OutboundEffectStoreError("providerReceiptDigest must be lowercase SHA-256");
  }
}

function snapshotReceipt(value: OutboundEffectReceipt): OutboundEffectReceipt {
  return {
    destination: value.destination,
    messageId: value.messageId,
    providerId: value.providerId,
    receivedAt: value.receivedAt,
    ...(value.providerReceiptDigest !== undefined
      ? { providerReceiptDigest: value.providerReceiptDigest }
      : {})
  };
}

function assertReceiptRoute(binding: OutboundEffectBinding, receipt: OutboundEffectReceipt): void {
  if (receipt.providerId !== binding.providerId || receipt.destination !== binding.destination) {
    throw new OutboundEffectStoreError(`provider receipt route drift for effect: ${binding.effectId}`);
  }
}

function assertAcceptedTimes(
  binding: OutboundEffectBinding,
  receipt: OutboundEffectReceipt,
  recordedAt: string
): void {
  assertAtOrAfter(receipt.receivedAt, binding.createdAt, "receipt.receivedAt");
  assertAtOrAfter(recordedAt, receipt.receivedAt, "accepted.recordedAt");
}

function assertAtOrAfter(value: string, earliest: string, field: string): void {
  if (Date.parse(value) < Date.parse(earliest)) {
    throw new OutboundEffectStoreError(`${field} must not precede the prior durable state`);
  }
}

function assertTimestamp(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new OutboundEffectStoreError(`${field} must be a canonical ISO timestamp`);
  }
}

function assertExactText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new OutboundEffectStoreError(`${field} must be a non-empty exact string`);
  }
}

function assertBoundedDetail(value: string, field: string): void {
  assertExactText(value, field);
  if (value.length > MAX_DETAIL_LENGTH) throw new OutboundEffectStoreError(`${field} is too long`);
}

function isEvent(value: unknown): value is OutboundEffectEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event["eventId"] !== "string"
    || !SHA256_RE.test(event["eventId"])
    || typeof event["previousHash"] !== "string"
    || !SHA256_RE.test(event["previousHash"])
    || typeof event["hash"] !== "string"
    || !SHA256_RE.test(event["hash"])) return false;
  switch (event["type"]) {
    case "prepared":
      return isExactObject(event, ["binding", "eventId", "hash", "previousHash", "type"])
        && isBinding(event["binding"]);
    case "accepted":
      return isExactObject(event, ["effectId", "eventId", "hash", "preparedEventId", "previousHash", "receipt", "recordedAt", "type"])
        && exactEventReference(event)
        && isReceipt(event["receipt"])
        && isTimestamp(event["recordedAt"]);
    case "unknown":
      return isExactObject(event, ["detail", "effectId", "eventId", "hash", "preparedEventId", "previousHash", "recordedAt", "type"])
        && exactEventReference(event)
        && isBoundedText(event["detail"])
        && isTimestamp(event["recordedAt"]);
    case "reconciled": {
      const keys = ["actor", "decision", "effectId", "eventId", "hash", "previousHash", "reason", "recordedAt", "type", "unknownEventId"];
      if (event["receipt"] !== undefined) keys.push("receipt");
      return isExactObject(event, keys)
        && typeof event["effectId"] === "string"
        && isBoundedText(event["actor"])
        && isBoundedText(event["reason"])
        && isTimestamp(event["recordedAt"])
        && typeof event["unknownEventId"] === "string"
        && SHA256_RE.test(event["unknownEventId"])
        && (event["decision"] === "accepted" || event["decision"] === "not-delivered")
        && (event["decision"] === "accepted" ? isReceipt(event["receipt"]) : event["receipt"] === undefined);
    }
    default:
      return false;
  }
}

function exactEventReference(event: Record<string, unknown>): boolean {
  return isExactText(event["effectId"])
    && typeof event["preparedEventId"] === "string"
    && SHA256_RE.test(event["preparedEventId"]);
}

function isBinding(value: unknown): value is OutboundEffectBinding {
  if (!isExactObject(value, ["createdAt", "destination", "effectId", "payloadHash", "providerId"])) return false;
  try {
    assertBinding(value as unknown as OutboundEffectBinding);
    return true;
  } catch {
    return false;
  }
}

function isReceipt(value: unknown): value is OutboundEffectReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = ["destination", "messageId", "providerId", "receivedAt"];
  if ((value as Record<string, unknown>)["providerReceiptDigest"] !== undefined) keys.push("providerReceiptDigest");
  if (!isExactObject(value, keys)) return false;
  try {
    assertReceipt(value as unknown as OutboundEffectReceipt);
    return true;
  } catch {
    return false;
  }
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isBoundedText(value: unknown): value is string {
  return isExactText(value) && value.length <= MAX_DETAIL_LENGTH;
}

function isExactText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value as object).sort().join("\0") === [...keys].sort().join("\0");
}

function hashEvent(event: OutboundEffectEvent): string {
  const { hash: _hash, ...withoutHash } = event;
  return sha256(canonicalJson(withoutHash));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameOptionalJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new OutboundEffectStoreError("outbound effect data must contain finite JSON numbers");
      return input;
    }
    if (Array.isArray(input)) {
      if (seen.has(input)) throw new OutboundEffectStoreError("outbound effect data must be acyclic");
      seen.add(input);
      const output = input.map(normalize);
      seen.delete(input);
      return output;
    }
    if (input && typeof input === "object") {
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new OutboundEffectStoreError("outbound effect data must contain plain JSON objects");
      }
      if (seen.has(input)) throw new OutboundEffectStoreError("outbound effect data must be acyclic");
      seen.add(input);
      const output = Object.fromEntries(
        Object.keys(input as Record<string, unknown>).sort().map((key) => [
          key,
          normalize((input as Record<string, unknown>)[key])
        ])
      );
      seen.delete(input);
      return output;
    }
    throw new OutboundEffectStoreError("outbound effect data must be exact JSON");
  };
  return JSON.stringify(normalize(value));
}
