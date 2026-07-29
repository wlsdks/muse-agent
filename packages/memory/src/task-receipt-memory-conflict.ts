import { createHash } from "node:crypto";

import {
  exactUserMemoryId,
  type ExactUserMemoryEntry
} from "./memory-user-store-file.js";
import { normalizeMemoryKey, sanitizeUserMemoryValue } from "./memory-user-store.js";

const MEMORY_KEYS = ["exactId", "key", "kind", "value", "version"] as const;
const RECEIPT_KEYS = [
  "artifactId",
  "completedAt",
  "doneStateFingerprint",
  "evidenceClass",
  "id",
  "providerId",
  "transition"
] as const;

export interface ExactTaskCompletionReceipt {
  readonly artifactId: string;
  readonly completedAt: string;
  readonly doneStateFingerprint: string;
  readonly evidenceClass: "controlled-live" | "organic";
  readonly id: string;
  readonly providerId: "local";
  readonly transition: "open-to-done";
}

export interface TaskReceiptMemoryConflict {
  readonly authority: {
    readonly feedback: "none";
    readonly memoryMutation: "none";
    readonly permission: "none";
    readonly policyEffect: "none";
    readonly preferencePromotion: "none";
    readonly requiresOwnerDecision: true;
  };
  readonly domain: {
    readonly artifactId: string;
    readonly completedAt: string;
    readonly doneStateFingerprint: string;
    readonly evidenceClass: "controlled-live" | "organic";
    readonly receiptId: string;
    readonly status: "done";
  };
  readonly memory: ExactUserMemoryEntry & { readonly kind: "fact" };
}

export function taskStatusMemoryKey(artifactId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["muse.task-status-memory-key/v1", artifactId]))
    .digest("hex")
    .slice(0, 24);
  return `task_status_${digest}`;
}

/**
 * Compare one exact factual task-completion receipt with one exact memory fact.
 * This is a display-only conflict: neither source is promoted over the other.
 */
export function projectTaskReceiptMemoryConflict(
  userId: string,
  target: ExactUserMemoryEntry,
  receipt: ExactTaskCompletionReceipt
): TaskReceiptMemoryConflict | undefined {
  if (
    typeof userId !== "string" || userId.length === 0
    || !isExactTaskCompletionReceipt(receipt)
    || !hasExactKeys(target, MEMORY_KEYS)
    || target.kind !== "fact"
    || target.key !== taskStatusMemoryKey(receipt.artifactId)
    || target.key !== normalizeMemoryKey(target.key)
    || target.exactId !== exactUserMemoryId(userId, "fact", target.key)
    || !Number.isSafeInteger(target.version) || target.version < 1
    || typeof target.value !== "string" || target.value.length === 0
    || sanitizeUserMemoryValue(target.value) !== target.value
  ) return undefined;
  const memoryStatus = normalizeMemoryKey(target.value);
  if (memoryStatus === "done" || memoryStatus === "completed") return undefined;

  return Object.freeze({
    authority: Object.freeze({
      feedback: "none",
      memoryMutation: "none",
      permission: "none",
      policyEffect: "none",
      preferencePromotion: "none",
      requiresOwnerDecision: true
    }),
    domain: Object.freeze({
      artifactId: receipt.artifactId,
      completedAt: receipt.completedAt,
      doneStateFingerprint: receipt.doneStateFingerprint,
      evidenceClass: receipt.evidenceClass,
      receiptId: receipt.id,
      status: "done"
    }),
    memory: Object.freeze({
      exactId: target.exactId,
      key: target.key,
      kind: "fact",
      value: target.value,
      version: target.version
    })
  });
}

function isExactTaskCompletionReceipt(value: unknown): value is ExactTaskCompletionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!hasExactKeys(value, RECEIPT_KEYS)) return false;
  const receipt = value as Partial<ExactTaskCompletionReceipt>;
  return typeof receipt.artifactId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(receipt.artifactId)
    && typeof receipt.id === "string"
    && receipt.id.length >= 8 && receipt.id.length <= 200
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(receipt.id)
    && typeof receipt.completedAt === "string"
    && Number.isFinite(Date.parse(receipt.completedAt))
    && typeof receipt.doneStateFingerprint === "string"
    && receipt.doneStateFingerprint.length >= 8
    && receipt.doneStateFingerprint.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(receipt.doneStateFingerprint)
    && (receipt.evidenceClass === "controlled-live" || receipt.evidenceClass === "organic")
    && receipt.providerId === "local"
    && receipt.transition === "open-to-done";
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[]
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
