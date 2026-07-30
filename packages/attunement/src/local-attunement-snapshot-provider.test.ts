import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LOCAL_ATTUNEMENT_SNAPSHOT_MAX_RAW_STATE_BYTES,
  LocalAttunementSnapshotProviderError,
  LocalAttunementSnapshotReceiptError,
  createLocalAttunementSnapshotProvider,
  createLocalAttunementSnapshotProviderForTesting,
  verifyLocalAttunementSnapshotReceiptIntegrity,
  verifyMintedLocalAttunementSnapshotCapture
} from "./local-attunement-snapshot-provider.js";
import { baselinePolicy } from "./policy-reducer.js";
import { writeAttunementState } from "./attunement-store.js";

import type { AttunementState } from "./types.js";
import type {
  LocalAttunementSnapshotCapture,
  LocalAttunementSnapshotReceipt
} from "./local-attunement-snapshot-provider.js";

const AT = "2026-07-29T12:00:00.000Z";
const SOURCE_ID = "default";
const THREAD_ID = "thread_trip";

function state(
  title = "Trip planning",
  threadId = THREAD_ID
): AttunementState {
  return {
    deliveries: [],
    experienceLearningPolicyAudits: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 12,
    threads: [
      {
        createdAt: "2026-07-20T09:00:00.000Z",
        id: threadId,
        kind: "life",
        links: [],
        policy: baselinePolicy(),
        title
      }
    ],
    undoResetReceipts: []
  };
}

function options(file: string): {
  readonly attunementFile: string;
  readonly sourceId: string;
  readonly clock: () => Date;
} {
  return {
    attunementFile: file,
    sourceId: SOURCE_ID,
    clock: () => new Date(AT)
  };
}

function scope(
  sourceId = SOURCE_ID,
  threadId = THREAD_ID
): { readonly sourceId: string; readonly threadId: string } {
  return { sourceId, threadId };
}

async function withTempFile<T>(
  operation: (file: string) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "muse-attunement-snapshot-"));
  try {
    return await operation(join(directory, "attunement.json"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectProviderError(
  error: unknown,
  code: LocalAttunementSnapshotProviderError["code"],
  reason: LocalAttunementSnapshotProviderError["details"]["reason"],
  path: string
): void {
  expect(error).toBeInstanceOf(LocalAttunementSnapshotProviderError);
  const actual = error as LocalAttunementSnapshotProviderError;
  expect(actual.message).toBe("local-attunement-snapshot-provider-failed");
  expect(actual.code).toBe(code);
  expect(actual.details).toEqual({ path, reason });
  expect(actual.stack).toBeUndefined();
  expect(Object.keys(actual).sort()).toEqual(["code", "details"]);
  expect(Object.isFrozen(actual)).toBe(true);
  expect(Object.isFrozen(actual.details)).toBe(true);
}

function expectReceiptError(
  operation: () => unknown,
  code: LocalAttunementSnapshotReceiptError["code"],
  reason: LocalAttunementSnapshotReceiptError["details"]["reason"],
  path: string
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(LocalAttunementSnapshotReceiptError);
    const actual = error as LocalAttunementSnapshotReceiptError;
    expect(actual.message).toBe("local-attunement-snapshot-receipt-failed");
    expect(actual.code).toBe(code);
    expect(actual.details).toEqual({ path, reason });
    expect(actual.stack).toBeUndefined();
    expect(Object.keys(actual).sort()).toEqual(["code", "details"]);
    expect(Object.isFrozen(actual)).toBe(true);
    return;
  }
  throw new Error("expected LocalAttunementSnapshotReceiptError");
}

function expectAvailable(
  value: LocalAttunementSnapshotCapture
): asserts value is Extract<LocalAttunementSnapshotCapture, { status: "available" }> {
  expect(value.status).toBe("available");
}

describe("local Attunement snapshot Provider", () => {
  it("rejects hostile factory configuration without executing accessors or Proxy traps", () => {
    let getterCalls = 0;
    let proxyTraps = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "attunementFile", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "/configured/attunement.json";
      }
    });
    Object.defineProperty(accessor, "sourceId", {
      enumerable: true,
      value: SOURCE_ID
    });
    expect(() => createLocalAttunementSnapshotProvider(
      accessor as unknown as Parameters<typeof createLocalAttunementSnapshotProvider>[0]
    )).toThrow(LocalAttunementSnapshotProviderError);

    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          proxyTraps += 1;
          throw new Error("must not execute");
        },
        ownKeys() {
          proxyTraps += 1;
          throw new Error("must not execute");
        }
      }
    );
    expect(() => createLocalAttunementSnapshotProvider(
      proxy as Parameters<typeof createLocalAttunementSnapshotProvider>[0]
    )).toThrow(LocalAttunementSnapshotProviderError);

    const symbolConfiguration = {
      ...options("/configured/attunement.json"),
      [Symbol("extra")]: true
    };
    expect(() => createLocalAttunementSnapshotProvider(symbolConfiguration))
      .toThrow(LocalAttunementSnapshotProviderError);
    expect(() => createLocalAttunementSnapshotProvider(
      Object.assign(
        Object.create({ inherited: true }) as Record<string, unknown>,
        options("/configured/attunement.json")
      ) as unknown as Parameters<typeof createLocalAttunementSnapshotProvider>[0]
    )).toThrow(LocalAttunementSnapshotProviderError);
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toBe(0);
  });

  it("mints one bounded available capture from the configured local store", async () => {
    await withTempFile(async (file) => {
      await writeAttunementState(file, state());
      const provider = createLocalAttunementSnapshotProvider(options(file));
      const capture = await provider.capture(scope());
      expectAvailable(capture);

      const verifiedReceipt = verifyLocalAttunementSnapshotReceiptIntegrity(
        capture.receipt
      );
      const verifiedCapture = verifyMintedLocalAttunementSnapshotCapture(capture);
      expect(verifiedCapture).toBe(capture);
      expect(verifiedReceipt).toEqual(capture.receipt);
      expect(capture.receipt.authority).toBe("receipt-integrity-only");
      expect(capture.receipt.freshness).toEqual({
        reason: "single-read-no-head-revalidation",
        status: "unassessed"
      });
      expect(capture.receipt.captureCompletedAt).toBe(AT);
      expect(capture.receipt.stateDigest).toBe(
        `sha256:${createHash("sha256")
          .update(capture.normalizedStateJson)
          .digest("hex")}`
      );
      expect(capture.receipt.normalizedStateBytes).toBe(
        Buffer.byteLength(capture.normalizedStateJson)
      );
      expect(JSON.parse(capture.normalizedStateJson)).toMatchObject({
        schemaVersion: 13,
        threads: [{ id: THREAD_ID }]
      });
    });
  });

  it("normalizes formatting and object-key order before identity", async () => {
    await withTempFile(async (file) => {
      const value = state();
      await writeFile(file, JSON.stringify(value), "utf8");
      const first = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      await writeFile(file, `${JSON.stringify({
        undoResetReceipts: value.undoResetReceipts,
        threads: value.threads.map((thread) => ({
          title: thread.title,
          policy: thread.policy,
          links: thread.links,
          kind: thread.kind,
          id: thread.id,
          createdAt: thread.createdAt
        })),
        schemaVersion: value.schemaVersion,
        resetReceipts: value.resetReceipts,
        nextPolicyVersion: value.nextPolicyVersion,
        interactionReceipts: value.interactionReceipts,
        experienceLearningPolicyAudits: value.experienceLearningPolicyAudits,
        deliveries: value.deliveries
      }, null, 2)}\n`, "utf8");
      const second = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      expectAvailable(first);
      expectAvailable(second);
      expect(second.normalizedStateJson).toBe(first.normalizedStateJson);
      expect(second.receipt).toEqual(first.receipt);
    });
  });

  it("changes identity for normalized state, scope, or clock changes", async () => {
    await withTempFile(async (file) => {
      await writeAttunementState(file, state());
      const first = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      await writeAttunementState(file, state("Changed title"));
      const changedState = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      const changedClock = await createLocalAttunementSnapshotProvider({
        ...options(file),
        clock: () => new Date("2026-07-29T12:00:01.000Z")
      }).capture(scope());
      expectAvailable(first);
      expectAvailable(changedState);
      expectAvailable(changedClock);
      expect(changedState.receipt.receiptId).not.toBe(first.receipt.receiptId);
      expect(changedClock.receipt.receiptId).not.toBe(
        changedState.receipt.receiptId
      );
    });
  });

  it("opens one source and samples one clock only after valid scope admission", async () => {
    let reads = 0;
    let clocks = 0;
    const provider = createLocalAttunementSnapshotProviderForTesting(
      options("/configured/attunement.json"),
      {
        readState: async () => {
          reads += 1;
          return { state: state(), status: "available" };
        },
        clock: () => {
          clocks += 1;
          return new Date(AT);
        }
      }
    );
    const capture = await provider.capture(scope());
    expect(capture.status).toBe("available");
    expect(reads).toBe(1);
    expect(clocks).toBe(1);

    await expect(provider.capture(scope("other"))).rejects.toSatisfy(
      (error: unknown) => {
        expectProviderError(
          error,
          "INVALID_SCOPE",
          "source-id-mismatch",
          "/scope/sourceId"
        );
        return true;
      }
    );
    expect(reads).toBe(1);
    expect(clocks).toBe(1);
  });

  it("freezes Provider identity and capture capability descriptors", () => {
    const provider = createLocalAttunementSnapshotProvider(
      options("/configured/attunement.json")
    );
    expect(Object.isFrozen(provider)).toBe(true);
    const descriptors = Object.getOwnPropertyDescriptors(provider);
    for (const key of ["providerId", "providerVersion", "sourceId", "capture"]) {
      expect(descriptors[key]).toMatchObject({
        configurable: false,
        enumerable: true,
        writable: false
      });
    }
    expect("attunementFile" in provider).toBe(false);
    expect(JSON.stringify(provider)).not.toContain("/configured");
  });

  it("keeps whole personal state non-enumerable and receipt-only logs clean", async () => {
    await withTempFile(async (file) => {
      const canary = `PRIVATE_CANARY_${randomUUID()}`;
      await writeAttunementState(file, state(canary));
      const capture = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      expectAvailable(capture);
      const descriptor = Object.getOwnPropertyDescriptor(
        capture,
        "normalizedStateJson"
      );
      expect(descriptor).toMatchObject({
        configurable: false,
        enumerable: false,
        writable: false
      });
      expect(capture.normalizedStateJson).toContain(canary);
      expect(Object.keys(capture)).not.toContain("normalizedStateJson");
      expect({ ...capture }).not.toHaveProperty("normalizedStateJson");
      expect(JSON.stringify(capture)).not.toContain(canary);
      expect(JSON.stringify(capture.receipt)).not.toContain(canary);
      expect(JSON.stringify(capture.receipt)).not.toContain(file);
      const descriptors = Object.getOwnPropertyDescriptors(capture);
      for (const key of ["status", "provenance", "receipt"]) {
        expect(descriptors[key]).toMatchObject({
          configurable: false,
          enumerable: true,
          writable: false
        });
      }
      expect(Object.isFrozen(capture)).toBe(true);
      expect(Object.isFrozen(capture.receipt)).toBe(true);
      expect(Object.isFrozen(capture.receipt.coverage)).toBe(true);
    });
  });

  it("separates serializable receipt integrity from minted provenance", async () => {
    await withTempFile(async (file) => {
      await writeAttunementState(file, state());
      const capture = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      expectAvailable(capture);
      const receiptClone = clone(capture.receipt);
      expect(
        verifyLocalAttunementSnapshotReceiptIntegrity(receiptClone)
      ).toEqual(capture.receipt);
      const reconstructed = {
        status: capture.status,
        provenance: capture.provenance,
        normalizedStateJson: capture.normalizedStateJson,
        receipt: receiptClone
      };
      expectReceiptError(
        () => verifyMintedLocalAttunementSnapshotCapture(reconstructed),
        "UNTRUSTED_CAPTURE",
        "not-minted",
        "/"
      );
    });
  });

  it("rejects receipt tampering and future Provider identity", async () => {
    await withTempFile(async (file) => {
      await writeAttunementState(file, state());
      const capture = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      expectAvailable(capture);
      const digestTamper = clone(capture.receipt) as unknown as Record<string, unknown>;
      digestTamper.stateDigest = `sha256:${"f".repeat(64)}`;
      expectReceiptError(
        () => verifyLocalAttunementSnapshotReceiptIntegrity(digestTamper),
        "INTEGRITY_MISMATCH",
        "receipt-integrity-mismatch",
        "/receiptId"
      );
      const providerTamper = clone(capture.receipt) as unknown as Record<string, unknown>;
      providerTamper.providerVersion = "muse.local-attunement-snapshot-provider.v2";
      expectReceiptError(
        () => verifyLocalAttunementSnapshotReceiptIntegrity(providerTamper),
        "INVALID_RECEIPT",
        "invalid-provider",
        "/providerVersion"
      );
    });
  });

  it("abstains conservatively for missing files and requested scopes", async () => {
    await withTempFile(async (file) => {
      const missing = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      expect(missing.status).toBe("abstained");
      if (missing.status === "abstained") {
        expect(missing.receipt.reason).toBe("requested-scope-unavailable");
        expect(missing.receipt.coverage.canAssertAbsenceWithinSnapshot).toBe(false);
      }

      await writeAttunementState(file, state("Other", "thread_other"));
      const unavailable = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      expect(unavailable.status).toBe("abstained");
      if (unavailable.status === "abstained") {
        expect(unavailable.receipt.reason).toBe("requested-scope-unavailable");
        expect("normalizedStateJson" in unavailable).toBe(false);
      }
    });
  });

  it.each([
    ["malformed JSON", "not-json"],
    [
      "future schema",
      JSON.stringify({
        ...state(),
        schemaVersion: 99
      })
    ]
  ])("maps %s to one non-leaking source read failure", async (_name, raw) => {
    await withTempFile(async (file) => {
      await writeFile(file, raw, "utf8");
      const capture = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      expect(capture.status).toBe("abstained");
      if (capture.status === "abstained") {
        expect(capture.receipt.reason).toBe("source-read-failed");
        expect(JSON.stringify(capture)).not.toContain(file);
        expect(JSON.stringify(capture)).not.toContain("not-json");
      }
    });
  });

  it("bounds raw source bytes before JSON parsing", async () => {
    await withTempFile(async (file) => {
      await writeFile(
        file,
        Buffer.alloc(LOCAL_ATTUNEMENT_SNAPSHOT_MAX_RAW_STATE_BYTES + 1, 0x20)
      );
      const capture = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      expect(capture.status).toBe("abstained");
      if (capture.status === "abstained") {
        expect(capture.receipt.reason).toBe("source-capacity-exceeded");
      }
    });
  });

  it("bounds normalized state from the package-private read seam", async () => {
    const provider = createLocalAttunementSnapshotProviderForTesting(
      options("/configured/attunement.json"),
      {
        readState: async () => ({
          state: state("x".repeat(LOCAL_ATTUNEMENT_SNAPSHOT_MAX_RAW_STATE_BYTES)),
          status: "available"
        })
      }
    );
    const capture = await provider.capture(scope());
    expect(capture.status).toBe("abstained");
    if (capture.status === "abstained") {
      expect(capture.receipt.reason).toBe("source-capacity-exceeded");
    }
  });

  it("rejects invalid clocks without publishing a receipt", async () => {
    for (const clock of [
      () => new Date(Number.NaN),
      () => {
        throw new Error("private clock detail");
      }
    ]) {
      const provider = createLocalAttunementSnapshotProviderForTesting(
        options("/configured/attunement.json"),
        {
          readState: async () => ({ status: "missing" }),
          clock
        }
      );
      await expect(provider.capture(scope())).rejects.toSatisfy(
        (error: unknown) => {
          expectProviderError(
            error,
            "INTERNAL_POSTCONDITION_FAILED",
            "invalid-clock",
            "/captureCompletedAt"
          );
          expect(JSON.stringify(error)).not.toContain("private clock detail");
          return true;
        }
      );
    }
  });

  it("maps a bounded source I/O rejection to one conservative receipt", async () => {
    let clocks = 0;
    const provider = createLocalAttunementSnapshotProviderForTesting(
      options("/configured/private-attunement.json"),
      {
        readState: async () => {
          throw new Error("SECRET_READ /configured/private-attunement.json");
        },
        clock: () => {
          clocks += 1;
          return new Date(AT);
        }
      }
    );
    const capture = await provider.capture(scope());
    expect(capture.status).toBe("abstained");
    if (capture.status === "abstained") {
      expect(capture.receipt.reason).toBe("source-read-failed");
      expect(JSON.stringify(capture)).not.toContain("private-attunement");
    }
    expect(clocks).toBe(1);
  });

  it("maps hostile Date methods to the stable clock postcondition error", async () => {
    class HostileDate extends Date {
      override getTime(): number {
        throw new Error("SECRET_CLOCK");
      }
    }
    const provider = createLocalAttunementSnapshotProviderForTesting(
      options("/configured/attunement.json"),
      {
        readState: async () => ({ status: "missing" }),
        clock: () => new HostileDate(AT)
      }
    );
    await expect(provider.capture(scope())).rejects.toSatisfy(
      (error: unknown) => {
        expectProviderError(
          error,
          "INTERNAL_POSTCONDITION_FAILED",
          "invalid-clock",
          "/captureCompletedAt"
        );
        expect(JSON.stringify(error)).not.toContain("SECRET_CLOCK");
        return true;
      }
    );
  });

  it.each([
    ["null", null],
    ["missing available state", { status: "available" }],
    ["unknown status", { status: "other" }],
    ["extra disposition field", { status: "missing", extra: true }]
  ])("rejects malformed bounded read disposition: %s", async (_name, disposition) => {
    const provider = createLocalAttunementSnapshotProviderForTesting(
      options("/configured/attunement.json"),
      {
        readState: async () => disposition as never
      }
    );
    await expect(provider.capture(scope())).rejects.toSatisfy(
      (error: unknown) => {
        expectProviderError(
          error,
          "INTERNAL_POSTCONDITION_FAILED",
          "bounded-read-postcondition-failed",
          "/source"
        );
        return true;
      }
    );
  });

  it("rejects hostile scope accessors and Proxies without executing them", async () => {
    let getterCalls = 0;
    let proxyTraps = 0;
    let reads = 0;
    const provider = createLocalAttunementSnapshotProviderForTesting(
      options("/configured/attunement.json"),
      {
        readState: async () => {
          reads += 1;
          return { status: "missing" };
        }
      }
    );
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "sourceId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return SOURCE_ID;
      }
    });
    Object.defineProperty(accessor, "threadId", {
      enumerable: true,
      value: THREAD_ID
    });
    await expect(provider.capture(accessor)).rejects.toBeInstanceOf(
      LocalAttunementSnapshotProviderError
    );
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          proxyTraps += 1;
          throw new Error("must not execute");
        },
        ownKeys() {
          proxyTraps += 1;
          throw new Error("must not execute");
        }
      }
    );
    await expect(provider.capture(proxy)).rejects.toBeInstanceOf(
      LocalAttunementSnapshotProviderError
    );
    const symbolScope = {
      ...scope(),
      [Symbol("extra")]: true
    };
    await expect(provider.capture(symbolScope)).rejects.toBeInstanceOf(
      LocalAttunementSnapshotProviderError
    );
    const unsupportedPrototype = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      scope()
    );
    await expect(provider.capture(unsupportedPrototype)).rejects.toBeInstanceOf(
      LocalAttunementSnapshotProviderError
    );
    await expect(provider.capture(scope(SOURCE_ID, "x".repeat(513)))).rejects
      .toBeInstanceOf(LocalAttunementSnapshotProviderError);
    const cyclic = scope() as unknown as Record<string, unknown>;
    cyclic.threadId = cyclic;
    await expect(provider.capture(cyclic)).rejects.toBeInstanceOf(
      LocalAttunementSnapshotProviderError
    );
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toBe(0);
    expect(reads).toBe(0);
  });

  it("rejects whitespace identity instead of silently normalizing it", async () => {
    const provider = createLocalAttunementSnapshotProviderForTesting(
      options("/configured/attunement.json"),
      { readState: async () => ({ status: "missing" }) }
    );
    await expect(provider.capture(scope(SOURCE_ID, ` ${THREAD_ID} `))).rejects
      .toSatisfy((error: unknown) => {
        expectProviderError(
          error,
          "INVALID_SCOPE",
          "invalid-thread-id",
          "/scope/threadId"
        );
        return true;
      });
  });

  it("rejects hostile receipt accessors, Proxies, aliases, and cycles", async () => {
    await withTempFile(async (file) => {
      await writeAttunementState(file, state());
      const capture = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      expectAvailable(capture);

      let getterCalls = 0;
      const accessor = clone(capture.receipt) as unknown as Record<string, unknown>;
      Object.defineProperty(accessor, "receiptId", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return capture.receipt.receiptId;
        }
      });
      expectReceiptError(
        () => verifyLocalAttunementSnapshotReceiptIntegrity(accessor),
        "INVALID_RECEIPT",
        "invalid-envelope",
        "/"
      );
      expect(getterCalls).toBe(0);

      let traps = 0;
      const proxy = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            traps += 1;
            throw new Error("must not execute");
          }
        }
      );
      expectReceiptError(
        () => verifyLocalAttunementSnapshotReceiptIntegrity(proxy),
        "INVALID_RECEIPT",
        "invalid-envelope",
        "/"
      );
      expect(traps).toBe(0);

      const aliased = clone(capture.receipt) as unknown as Record<string, unknown>;
      aliased.freshness = aliased.scope;
      expectReceiptError(
        () => verifyLocalAttunementSnapshotReceiptIntegrity(aliased),
        "INVALID_RECEIPT",
        "invalid-envelope",
        "/freshness"
      );

      const cyclic = clone(capture.receipt) as unknown as Record<string, unknown>;
      cyclic.scope = cyclic;
      expectReceiptError(
        () => verifyLocalAttunementSnapshotReceiptIntegrity(cyclic),
        "INVALID_RECEIPT",
        "invalid-envelope",
        "/scope"
      );

      for (const length of [4, 1_000_000]) {
        const sparse = clone(capture.receipt) as unknown as {
          coverage: { reasons: string[] };
        };
        sparse.coverage.reasons.length = length;
        expectReceiptError(
          () => verifyLocalAttunementSnapshotReceiptIntegrity(sparse),
          "INVALID_RECEIPT",
          "invalid-envelope",
          "/coverage/reasons"
        );
      }
    });
  });

  it("returns deeply frozen integrity receipts for both terminal states", async () => {
    await withTempFile(async (file) => {
      await writeAttunementState(file, state());
      const available = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      const abstained = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope(SOURCE_ID, "thread_missing"));
      for (const capture of [available, abstained]) {
        const receipt = verifyLocalAttunementSnapshotReceiptIntegrity(
          capture.receipt
        );
        expect(Object.isFrozen(receipt)).toBe(true);
        expect(Object.isFrozen(receipt.scope)).toBe(true);
        expect(Object.isFrozen(receipt.freshness)).toBe(true);
        expect(Object.isFrozen(receipt.coverage)).toBe(true);
        expect(Object.isFrozen(receipt.coverage.reasons)).toBe(true);
      }
    });
  });

  it("keeps the exact public receipt shape detached from caller mutation", async () => {
    await withTempFile(async (file) => {
      await writeAttunementState(file, state());
      const capture = await createLocalAttunementSnapshotProvider(options(file))
        .capture(scope());
      const mutable = clone(capture.receipt) as LocalAttunementSnapshotReceipt;
      const verified = verifyLocalAttunementSnapshotReceiptIntegrity(mutable);
      (mutable.scope as { sourceId: string }).sourceId = "changed";
      expect(verified.scope.sourceId).toBe(SOURCE_ID);
      expect(verified.receiptId).toBe(capture.receipt.receiptId);
    });
  });
});
