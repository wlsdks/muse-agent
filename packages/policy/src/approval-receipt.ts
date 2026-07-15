import { createHash } from "node:crypto";

import type { JsonValue } from "@muse/shared";

import {
  isApprovalBindingAllowedForCapabilityProfile,
  isApprovalOperationAllowedForCapabilityProfile,
  resolveCapabilityProfile
} from "./capability-profile.js";

export const APPROVAL_RECEIPT_VERSION = 1 as const;

export type ApprovalReceiptRisk = "local-write" | "external-action" | "external-send";

export interface ApprovalReceiptBinding {
  readonly userId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly profileId: string;
  readonly operation: string;
  readonly arguments: JsonValue;
  readonly artifactHash: string | null;
  readonly sourceHash: string | null;
  readonly destination: string | null;
  readonly host: string | null;
  readonly risk: ApprovalReceiptRisk;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly traceId: string;
}

export interface ApprovalReceipt {
  readonly version: typeof APPROVAL_RECEIPT_VERSION;
  readonly binding: ApprovalReceiptBinding;
  readonly bindingDigest: string;
}

export interface ApprovalReceiptClockOptions {
  readonly now?: () => Date;
}

export type ApprovalReceiptFailureReason =
  | "already-consumed"
  | "binding-mismatch"
  | "expired"
  | "invalid-receipt"
  | "unknown-receipt";

export type ApprovalReceiptValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: Exclude<ApprovalReceiptFailureReason, "already-consumed" | "unknown-receipt"> };

export type ApprovalReceiptConsumeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ApprovalReceiptFailureReason };

export interface ApprovalReceiptConsumeInput {
  readonly receipt: ApprovalReceipt;
  readonly expectedBinding: ApprovalReceiptBinding;
}

/**
 * Persistence implementations expose only atomic issue and consume operations.
 * A future database adapter must keep `consume` a single transaction rather
 * than reconstructing it as an unsafe get-then-set at a call site.
 */
export interface ApprovalReceiptStore {
  issue(binding: ApprovalReceiptBinding): Promise<ApprovalReceipt>;
  consume(input: ApprovalReceiptConsumeInput): Promise<ApprovalReceiptConsumeResult>;
}

interface NormalizedApprovalReceiptBinding extends ApprovalReceiptBinding {
  readonly arguments: JsonValue;
}

const HASH_RE = /^[a-f0-9]{64}$/iu;
const RISKS = new Set<ApprovalReceiptRisk>(["local-write", "external-action", "external-send"]);

function assertNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Approval receipt ${field} must be a non-empty string`);
  }
  return value;
}

function normalizeNullableHash(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new TypeError(`Approval receipt ${field} must be a SHA-256 hex digest or null`);
  }
  return value.toLowerCase();
}

function normalizeNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return assertNonBlank(value, field);
}

function normalizeExpiry(value: unknown): string {
  const expiresAt = assertNonBlank(value, "expiresAt");
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Approval receipt expiresAt must be a valid timestamp");
  }
  return new Date(timestamp).toISOString();
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Approval receipt arguments must contain a finite JSON number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }
  if (!value || typeof value !== "object") {
    throw new TypeError("Approval receipt arguments must be valid JSON");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Approval receipt arguments must be plain JSON objects");
  }

  const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalizeJsonValue((value as Record<string, unknown>)[key]);
  }
  return normalized;
}

function normalizeBinding(binding: ApprovalReceiptBinding): NormalizedApprovalReceiptBinding {
  if (!RISKS.has(binding.risk)) {
    throw new TypeError("Approval receipt risk is not supported");
  }

  return {
    arguments: normalizeJsonValue(binding.arguments),
    artifactHash: normalizeNullableHash(binding.artifactHash, "artifactHash"),
    destination: normalizeNullableString(binding.destination, "destination"),
    expiresAt: normalizeExpiry(binding.expiresAt),
    host: normalizeNullableString(binding.host, "host"),
    nonce: assertNonBlank(binding.nonce, "nonce"),
    operation: assertNonBlank(binding.operation, "operation"),
    profileId: assertNonBlank(binding.profileId, "profileId"),
    risk: binding.risk,
    runId: assertNonBlank(binding.runId, "runId"),
    sessionId: assertNonBlank(binding.sessionId, "sessionId"),
    sourceHash: normalizeNullableHash(binding.sourceHash, "sourceHash"),
    traceId: assertNonBlank(binding.traceId, "traceId"),
    userId: assertNonBlank(binding.userId, "userId")
  };
}

function canonicalPayload(binding: NormalizedApprovalReceiptBinding): Record<string, JsonValue> {
  return {
    arguments: binding.arguments,
    artifactHash: binding.artifactHash,
    destination: binding.destination,
    expiresAt: binding.expiresAt,
    host: binding.host,
    nonce: binding.nonce,
    operation: binding.operation,
    profileId: binding.profileId,
    risk: binding.risk,
    runId: binding.runId,
    sessionId: binding.sessionId,
    sourceHash: binding.sourceHash,
    traceId: binding.traceId,
    userId: binding.userId,
    version: APPROVAL_RECEIPT_VERSION
  };
}

function currentTime(options: ApprovalReceiptClockOptions): Date {
  const now = options.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Approval receipt clock must return a valid Date");
  }
  return now;
}

function cloneReceipt(receipt: ApprovalReceipt): ApprovalReceipt {
  return {
    binding: normalizeBinding(receipt.binding),
    bindingDigest: receipt.bindingDigest,
    version: receipt.version
  };
}

/** Serializes every approval-critical field in a stable v1 order. */
export function canonicalizeApprovalReceiptBinding(binding: ApprovalReceiptBinding): string {
  return JSON.stringify(canonicalPayload(normalizeBinding(binding)));
}

/** SHA-256 digest used to bind a receipt to its exact canonical approval target. */
export function hashApprovalReceiptBinding(binding: ApprovalReceiptBinding): string {
  return createHash("sha256").update(canonicalizeApprovalReceiptBinding(binding)).digest("hex");
}

/** Creates a server-issued receipt for a registered capability profile. */
export function createApprovalReceipt(
  binding: ApprovalReceiptBinding,
  options: ApprovalReceiptClockOptions = {}
): ApprovalReceipt {
  const normalized = normalizeBinding(binding);
  if (!resolveCapabilityProfile(normalized.profileId)) {
    throw new Error(`Unknown capability profile: ${normalized.profileId}`);
  }
  if (!isApprovalOperationAllowedForCapabilityProfile(normalized.profileId, normalized.operation)) {
    throw new Error(`Operation is not allowed by capability profile: ${normalized.operation}`);
  }
  if (!isApprovalBindingAllowedForCapabilityProfile(normalized.profileId, normalized)) {
    throw new Error("Approval binding is not allowed by capability profile");
  }
  if (Date.parse(normalized.expiresAt) <= currentTime(options).getTime()) {
    throw new Error("Approval receipt expiresAt must be in the future");
  }

  return {
    binding: normalized,
    bindingDigest: hashApprovalReceiptBinding(normalized),
    version: APPROVAL_RECEIPT_VERSION
  };
}

/** Validates the receipt body, exact expected binding, profile, and expiry. */
export function validateApprovalReceipt(
  receipt: ApprovalReceipt,
  expectedBinding: ApprovalReceiptBinding,
  options: ApprovalReceiptClockOptions = {}
): ApprovalReceiptValidationResult {
  let normalizedReceiptBinding: NormalizedApprovalReceiptBinding;
  try {
    normalizedReceiptBinding = normalizeBinding(receipt.binding);
  } catch {
    return { ok: false, reason: "invalid-receipt" };
  }

  if (
    receipt.version !== APPROVAL_RECEIPT_VERSION
    || !HASH_RE.test(receipt.bindingDigest)
    || receipt.bindingDigest !== hashApprovalReceiptBinding(normalizedReceiptBinding)
    || !resolveCapabilityProfile(normalizedReceiptBinding.profileId)
    || !isApprovalOperationAllowedForCapabilityProfile(normalizedReceiptBinding.profileId, normalizedReceiptBinding.operation)
    || !isApprovalBindingAllowedForCapabilityProfile(normalizedReceiptBinding.profileId, normalizedReceiptBinding)
  ) {
    return { ok: false, reason: "invalid-receipt" };
  }

  let expectedDigest: string;
  try {
    expectedDigest = hashApprovalReceiptBinding(expectedBinding);
  } catch {
    return { ok: false, reason: "binding-mismatch" };
  }
  if (receipt.bindingDigest !== expectedDigest) {
    return { ok: false, reason: "binding-mismatch" };
  }
  if (Date.parse(normalizedReceiptBinding.expiresAt) <= currentTime(options).getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

interface StoredReceipt {
  readonly receipt: ApprovalReceipt;
  consumed: boolean;
}

/**
 * Test and single-process implementation of the atomic store contract. There
 * is intentionally no read API: callers can only issue or atomically consume.
 */
export class InMemoryApprovalReceiptStore implements ApprovalReceiptStore {
  private readonly now: () => Date;
  private readonly receipts = new Map<string, StoredReceipt>();

  constructor(options: ApprovalReceiptClockOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async issue(binding: ApprovalReceiptBinding): Promise<ApprovalReceipt> {
    const receipt = createApprovalReceipt(binding, { now: this.now });
    if (this.receipts.has(receipt.binding.nonce)) {
      throw new Error(`Approval receipt nonce already exists: ${receipt.binding.nonce}`);
    }
    this.receipts.set(receipt.binding.nonce, { consumed: false, receipt: cloneReceipt(receipt) });
    return cloneReceipt(receipt);
  }

  async consume(input: ApprovalReceiptConsumeInput): Promise<ApprovalReceiptConsumeResult> {
    const suppliedValidation = validateApprovalReceipt(input.receipt, input.expectedBinding, { now: this.now });
    if (!suppliedValidation.ok) {
      return suppliedValidation;
    }

    const stored = this.receipts.get(input.receipt.binding.nonce);
    if (!stored) {
      return { ok: false, reason: "unknown-receipt" };
    }

    const storedValidation = validateApprovalReceipt(stored.receipt, input.expectedBinding, { now: this.now });
    if (!storedValidation.ok) {
      return storedValidation;
    }
    if (stored.consumed) {
      return { ok: false, reason: "already-consumed" };
    }

    stored.consumed = true;
    return { ok: true };
  }
}
