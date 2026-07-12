import { describe, expect, it } from "vitest";

import {
  APPROVAL_RECEIPT_VERSION,
  InMemoryApprovalReceiptStore,
  PERSONAL_WORK_CAPABILITY_PROFILE_ID,
  canonicalizeApprovalReceiptBinding,
  createApprovalReceipt,
  hashApprovalReceiptBinding,
  type ApprovalReceiptBinding,
  validateApprovalReceipt
} from "../src/index.js";

const NOW = new Date("2026-07-13T00:00:00.000Z");
const EXPIRES_AT = "2026-07-13T00:10:00.000Z";
const ARTIFACT_HASH = "a".repeat(64);
const SOURCE_HASH = "b".repeat(64);

function binding(overrides: Partial<ApprovalReceiptBinding> = {}): ApprovalReceiptBinding {
  return {
    arguments: { b: 2, a: { z: true, y: ["note", 3] } },
    artifactHash: ARTIFACT_HASH,
    destination: null,
    expiresAt: EXPIRES_AT,
    host: null,
    nonce: "receipt-nonce-1",
    operation: "work.apply-local-task",
    profileId: PERSONAL_WORK_CAPABILITY_PROFILE_ID,
    risk: "local-write",
    runId: "run-1",
    sessionId: "session-1",
    sourceHash: SOURCE_HASH,
    traceId: "trace-1",
    userId: "user-1",
    ...overrides
  };
}

describe("ApprovalReceipt v1", () => {
  it("uses a stable versioned canonical binding regardless of argument key order", () => {
    const first = binding({ arguments: { b: 2, a: { z: true, y: ["note", 3] } } });
    const second = binding({ arguments: { a: { y: ["note", 3], z: true }, b: 2 } });

    expect(APPROVAL_RECEIPT_VERSION).toBe(1);
    expect(canonicalizeApprovalReceiptBinding(first)).toBe(canonicalizeApprovalReceiptBinding(second));
    expect(hashApprovalReceiptBinding(first)).toBe(hashApprovalReceiptBinding(second));
  });

  it("binds every approval-critical field and rejects a mismatch in any one of them", () => {
    const original = binding();
    const receipt = createApprovalReceipt(original, { now: () => NOW });
    const mutations: readonly [string, ApprovalReceiptBinding][] = [
      ["user", binding({ userId: "user-2" })],
      ["session", binding({ sessionId: "session-2" })],
      ["run", binding({ runId: "run-2" })],
      ["profile", binding({ profileId: "other-profile" })],
      ["operation", binding({ operation: "work.apply-other-task" })],
      ["arguments", binding({ arguments: { a: "changed" } })],
      ["artifact hash", binding({ artifactHash: "c".repeat(64) })],
      ["source hash", binding({ sourceHash: "d".repeat(64) })],
      ["destination", binding({ destination: "calendar://local/default" })],
      ["host", binding({ host: "example.test" })],
      ["risk", binding({ risk: "external-send" })],
      ["expiry", binding({ expiresAt: "2026-07-13T00:11:00.000Z" })],
      ["nonce", binding({ nonce: "receipt-nonce-2" })],
      ["trace", binding({ traceId: "trace-2" })]
    ];

    for (const [field, expectedBinding] of mutations) {
      expect(validateApprovalReceipt(receipt, expectedBinding, { now: () => NOW }), field).toEqual({
        ok: false,
        reason: "binding-mismatch"
      });
    }
  });

  it("rejects a version-tampered receipt body", () => {
    const original = binding();
    const receipt = createApprovalReceipt(original, { now: () => NOW });
    const versionTamperedReceipt = { ...receipt, version: 2 } as unknown as typeof receipt;

    expect(validateApprovalReceipt(versionTamperedReceipt, original, { now: () => NOW })).toEqual({
      ok: false,
      reason: "invalid-receipt"
    });
  });

  it("rejects receipt-binding body tampering in every approval-critical field", () => {
    const original = binding();
    const receipt = createApprovalReceipt(original, { now: () => NOW });
    const tamperedBindings: readonly [string, ApprovalReceiptBinding][] = [
      ["user", binding({ userId: "user-2" })],
      ["session", binding({ sessionId: "session-2" })],
      ["run", binding({ runId: "run-2" })],
      ["profile", binding({ profileId: "other-profile" })],
      ["operation", binding({ operation: "work.apply-other-task" })],
      ["arguments", binding({ arguments: { a: "changed" } })],
      ["artifact hash", binding({ artifactHash: "c".repeat(64) })],
      ["source hash", binding({ sourceHash: "d".repeat(64) })],
      ["destination", binding({ destination: "calendar://local/default" })],
      ["host", binding({ host: "example.test" })],
      ["risk", binding({ risk: "external-send" })],
      ["expiry", binding({ expiresAt: "2026-07-13T00:11:00.000Z" })],
      ["nonce", binding({ nonce: "receipt-nonce-2" })],
      ["trace", binding({ traceId: "trace-2" })]
    ];

    for (const [field, tamperedBinding] of tamperedBindings) {
      expect(
        validateApprovalReceipt({ ...receipt, binding: tamperedBinding }, original, { now: () => NOW }),
        field
      ).toEqual({ ok: false, reason: "invalid-receipt" });
    }
  });

  it("fails closed when expired or when the receipt digest was tampered with", () => {
    const original = binding();
    const receipt = createApprovalReceipt(original, { now: () => NOW });

    expect(validateApprovalReceipt(receipt, original, { now: () => new Date(EXPIRES_AT) })).toEqual({
      ok: false,
      reason: "expired"
    });
    expect(
      validateApprovalReceipt(
        { ...receipt, bindingDigest: "0".repeat(64) },
        original,
        { now: () => NOW }
      )
    ).toEqual({ ok: false, reason: "invalid-receipt" });
  });

  it("requires a registered profile and valid JSON arguments when a server issues a receipt", () => {
    expect(() => createApprovalReceipt(binding({ profileId: "other-profile" }), { now: () => NOW })).toThrow(
      "Unknown capability profile"
    );
    expect(() => createApprovalReceipt(binding({ arguments: Number.NaN }), { now: () => NOW })).toThrow(
      "finite JSON number"
    );
    expect(() => createApprovalReceipt(binding({ operation: "code.write" }), { now: () => NOW })).toThrow(
      "Operation is not allowed"
    );
    expect(() => createApprovalReceipt(binding({ risk: "external-send" }), { now: () => NOW })).toThrow(
      "Approval binding is not allowed"
    );
    expect(
      () => createApprovalReceipt(binding({ destination: "https://example.test/submit", host: "example.test" }), { now: () => NOW })
    ).toThrow("Approval binding is not allowed");
  });
});

describe("InMemoryApprovalReceiptStore", () => {
  it("consumes a receipt exactly once under concurrent requests", async () => {
    const store = new InMemoryApprovalReceiptStore({ now: () => NOW });
    const issued = await store.issue(binding());

    const outcomes = await Promise.all([
      store.consume({ expectedBinding: binding(), receipt: issued }),
      store.consume({ expectedBinding: binding(), receipt: issued })
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.map((outcome) => outcome.reason).sort()).toEqual(["already-consumed", undefined]);
  });

  it("does not consume a receipt when its expected binding is wrong", async () => {
    const store = new InMemoryApprovalReceiptStore({ now: () => NOW });
    const issued = await store.issue(binding());

    await expect(
      store.consume({ expectedBinding: binding({ host: "example.test" }), receipt: issued })
    ).resolves.toEqual({ ok: false, reason: "binding-mismatch" });
    await expect(store.consume({ expectedBinding: binding(), receipt: issued })).resolves.toEqual({ ok: true });
  });

  it("rejects duplicate nonces, unknown receipts, and expired receipts without a partial consume", async () => {
    const store = new InMemoryApprovalReceiptStore({ now: () => NOW });
    const issued = await store.issue(binding());

    await expect(store.issue(binding())).rejects.toThrow("already exists");
    const unissued = createApprovalReceipt(binding({ nonce: "receipt-nonce-unknown" }), { now: () => NOW });
    await expect(store.consume({ expectedBinding: binding({ nonce: "receipt-nonce-unknown" }), receipt: unissued })).resolves.toEqual({
      ok: false,
      reason: "unknown-receipt"
    });

    let currentTime = NOW;
    const expiredStore = new InMemoryApprovalReceiptStore({ now: () => currentTime });
    const stillValidAtIssue = await expiredStore.issue(binding({ nonce: "receipt-nonce-expired" }));
    currentTime = new Date(EXPIRES_AT);
    await expect(
      expiredStore.consume({ expectedBinding: binding({ nonce: "receipt-nonce-expired" }), receipt: stillValidAtIssue })
    ).resolves.toEqual({
      ok: false,
      reason: "expired"
    });
    await expect(
      expiredStore.consume({ expectedBinding: binding({ nonce: "receipt-nonce-expired" }), receipt: stillValidAtIssue })
    ).resolves.toEqual({
      ok: false,
      reason: "expired"
    });

    await expect(store.consume({ expectedBinding: binding(), receipt: issued })).resolves.toEqual({ ok: true });
  });
});
