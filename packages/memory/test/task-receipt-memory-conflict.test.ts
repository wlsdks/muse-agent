import { describe, expect, it } from "vitest";

import {
  exactUserMemoryId,
  projectTaskReceiptMemoryConflict,
  taskStatusMemoryKey,
  type ExactTaskCompletionReceipt,
  type ExactUserMemoryEntry
} from "../src/index.js";

const USER = "owner";
const TASK_ID = "task_01JZEXACT";
const KEY = taskStatusMemoryKey(TASK_ID);

function target(over: Partial<ExactUserMemoryEntry> = {}): ExactUserMemoryEntry {
  return {
    exactId: exactUserMemoryId(USER, "fact", KEY),
    key: KEY,
    kind: "fact",
    value: "open",
    version: 3,
    ...over
  };
}

function receipt(over: Partial<ExactTaskCompletionReceipt> = {}): ExactTaskCompletionReceipt {
  return {
    artifactId: TASK_ID,
    completedAt: "2026-07-29T12:00:00.000Z",
    doneStateFingerprint: "task_done_sha256_0123456789abcdef",
    evidenceClass: "organic",
    id: "interaction_receipt_01JZEXACT",
    providerId: "local",
    transition: "open-to-done",
    ...over
  };
}

describe("projectTaskReceiptMemoryConflict", () => {
  it("shows both exact sources while granting no correction, feedback, permission, or promotion authority", () => {
    const memory = target();
    const factual = receipt();
    const beforeMemory = JSON.stringify(memory);
    const beforeReceipt = JSON.stringify(factual);

    const first = projectTaskReceiptMemoryConflict(USER, memory, factual);
    const second = projectTaskReceiptMemoryConflict(USER, memory, factual);

    expect(first).toEqual(second);
    expect(first).toEqual({
      authority: {
        feedback: "none",
        memoryMutation: "none",
        permission: "none",
        policyEffect: "none",
        preferencePromotion: "none",
        requiresOwnerDecision: true
      },
      domain: {
        artifactId: TASK_ID,
        completedAt: "2026-07-29T12:00:00.000Z",
        doneStateFingerprint: "task_done_sha256_0123456789abcdef",
        evidenceClass: "organic",
        receiptId: "interaction_receipt_01JZEXACT",
        status: "done"
      },
      memory
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first!.authority)).toBe(true);
    expect(Object.isFrozen(first!.domain)).toBe(true);
    expect(Object.isFrozen(first!.memory)).toBe(true);
    expect(first).not.toHaveProperty("outcome");
    expect(first).not.toHaveProperty("approval");
    expect(JSON.stringify(memory)).toBe(beforeMemory);
    expect(JSON.stringify(factual)).toBe(beforeReceipt);
  });

  it("returns no conflict when the exact memory status already agrees", () => {
    expect(projectTaskReceiptMemoryConflict(USER, target({ value: "done" }), receipt())).toBeUndefined();
    expect(projectTaskReceiptMemoryConflict(USER, target({ value: "Completed" }), receipt())).toBeUndefined();
  });

  it("fails closed for fuzzy IDs, preference targets, other task keys, and malformed receipts", () => {
    expect(projectTaskReceiptMemoryConflict(USER, target({ exactId: KEY }), receipt())).toBeUndefined();
    expect(projectTaskReceiptMemoryConflict(USER, target({
      exactId: exactUserMemoryId(USER, "preference", KEY),
      kind: "preference"
    }), receipt())).toBeUndefined();
    expect(projectTaskReceiptMemoryConflict(USER, target(), receipt({ artifactId: "task_other" }))).toBeUndefined();
    expect(projectTaskReceiptMemoryConflict(USER, target(), receipt({
      doneStateFingerprint: "bad\nfingerprint"
    }))).toBeUndefined();
    expect(projectTaskReceiptMemoryConflict(USER, target(), receipt({
      evidenceClass: "synthetic" as ExactTaskCompletionReceipt["evidenceClass"]
    }))).toBeUndefined();
    const authorityShapedMemory = {
      ...target(),
      approval: true,
      outcome: "used",
      permission: "granted",
      policyEffect: "promote",
      writeAuthority: true
    } as ExactUserMemoryEntry;
    expect(
      projectTaskReceiptMemoryConflict(USER, authorityShapedMemory, receipt())
    ).toBeUndefined();
    expect(projectTaskReceiptMemoryConflict(USER, target(), {
      ...receipt(),
      approval: true
    } as ExactTaskCompletionReceipt)).toBeUndefined();
    expect(taskStatusMemoryKey("Task-1")).not.toBe(taskStatusMemoryKey("task_1"));
  });
});
