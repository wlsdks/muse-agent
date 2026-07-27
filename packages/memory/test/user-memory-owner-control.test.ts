import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  exactUserMemoryId,
  FileUserMemoryStore,
  USER_MEMORY_MUTATION_RECEIPT_SCHEMA,
  UserMemoryOwnerControlError
} from "../src/index.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "muse-memory-owner-"));
  const file = join(dir, "user-memory.json");
  let now = new Date("2026-07-27T10:00:00.000Z");
  return {
    file,
    setNow(value: string) {
      now = new Date(value);
    },
    store: new FileUserMemoryStore({ file, now: () => now })
  };
}

function expectControlError(code: string) {
  return (error: unknown): boolean =>
    error instanceof UserMemoryOwnerControlError && error.code === code;
}

describe("FileUserMemoryStore owner control", () => {
  it("atomically creates one normalized alias and refuses the concurrent overwrite", async () => {
    const { file, store } = await fixture();
    const results = await Promise.all([
      store.createFactIfAbsent("owner", "Home City", "Seoul"),
      store.createFactIfAbsent("owner", "home_city", "Busan")
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(1);
    const memory = await store.findByUserId("owner");
    expect(["Seoul", "Busan"]).toContain(memory?.facts.home_city);
    expect((await store.inspectOwnerMemory("owner"))[0]).toMatchObject({
      key: "home_city",
      version: 1
    });
    const beforeRejectedReplay = await readFile(file, "utf8");
    await expect(store.createFactIfAbsent("owner", "HOME CITY", "Incheon"))
      .resolves.toMatchObject({ created: false });
    expect(await readFile(file, "utf8")).toBe(beforeRejectedReplay);
    const parsed = JSON.parse(beforeRejectedReplay) as {
      users: { owner: { ownerControl: { mutationReceipts: unknown[] } } };
    };
    expect(parsed.users.owner.ownerControl.mutationReceipts).toEqual([]);
  });

  it("inspects stable exact IDs and previews without mutating bytes, receipts, or versions", async () => {
    const { file, store } = await fixture();
    await store.upsertFact("owner", "home_city", "Seoul");
    await store.upsertPreference("owner", "reply_style", "concise");

    const entries = await store.inspectOwnerMemory("owner");
    expect(entries).toEqual([
      {
        exactId: exactUserMemoryId("owner", "fact", "home_city"),
        key: "home_city",
        kind: "fact",
        value: "Seoul",
        version: 1
      },
      {
        exactId: exactUserMemoryId("owner", "preference", "reply_style"),
        key: "reply_style",
        kind: "preference",
        value: "concise",
        version: 1
      }
    ]);

    const before = await readFile(file, "utf8");
    await expect(store.previewOwnerMemory("owner", entries[0]!.exactId)).resolves.toEqual(entries[0]);
    expect(await readFile(file, "utf8")).toBe(before);
    const parsed = JSON.parse(before) as {
      users: { owner: { ownerControl: { mutationReceipts: unknown[] } } };
    };
    expect(parsed.users.owner.ownerControl.mutationReceipts).toEqual([]);
  });

  it("corrects once, replays duplicate requests, survives restart, and undo restores only the exact entry", async () => {
    const { file, store } = await fixture();
    await store.upsertFact("owner", "home_city", "Seoul");
    await store.upsertFact("owner", "timezone", "Asia/Seoul");
    const entry = (await store.inspectOwnerMemory("owner"))
      .find((candidate) => candidate.key === "home_city")!;

    const input = {
      exactId: entry.exactId,
      expectedVersion: entry.version,
      requestId: "correct-home-city-0001",
      value: "Busan"
    };
    const first = await store.correctOwnerMemory("owner", input);
    const sameRequest = await store.correctOwnerMemory("owner", input);
    expect(sameRequest).toEqual(first);
    await expect(store.correctOwnerMemory("owner", {
      ...input,
      requestId: "correct-home-city-retry"
    })).rejects.toSatisfy(expectControlError("conflict"));
    expect(first).toMatchObject({
      after: { deleted: false, value: "Busan", version: 2 },
      before: { value: "Seoul", version: 1 },
      operation: "correct",
      schemaVersion: USER_MEMORY_MUTATION_RECEIPT_SCHEMA,
      status: "applied",
      target: { exactId: entry.exactId, key: "home_city", kind: "fact" },
      undoScope: "exact-memory-entry-only"
    });

    const restarted = new FileUserMemoryStore({
      file,
      now: () => new Date("2026-07-27T10:01:00.000Z")
    });
    const undone = await restarted.undoOwnerMemory("owner", first.receiptId);
    const replayedUndo = await restarted.undoOwnerMemory("owner", first.receiptId);
    expect(replayedUndo).toEqual(undone);
    expect(undone.status).toBe("undone");
    expect(undone.undo).toMatchObject({ restoredVersion: 3 });
    expect((await restarted.previewOwnerMemory("owner", entry.exactId))).toMatchObject({
      value: "Seoul",
      version: 3
    });
    expect((await restarted.findByUserId("owner"))?.facts.timezone).toBe("Asia/Seoul");

    const raw = JSON.parse(await readFile(file, "utf8")) as {
      users: { owner: { ownerControl: { mutationReceipts: unknown[] } } };
    };
    expect(raw.users.owner.ownerControl.mutationReceipts).toHaveLength(1);
  });

  it("forgets once, rejects fuzzy aliases, and explicitly restores a deleted entry before expiry", async () => {
    const { store } = await fixture();
    await store.upsertFact("owner", "home_city", "Seoul");
    const entry = (await store.inspectOwnerMemory("owner"))[0]!;

    for (const fuzzy of [
      "home_city",
      "Home City",
      entry.exactId.slice(0, -1),
      entry.value,
      "mem_v1_00000000000000000000000000000000"
    ]) {
      await expect(store.previewOwnerMemory("owner", fuzzy)).rejects.toSatisfy(
        expectControlError(/^mem_v1_[a-f0-9]{32}$/u.test(fuzzy) ? "not-found" : "exact-id-required")
      );
    }

    const input = {
      exactId: entry.exactId,
      expectedVersion: 1,
      requestId: "forget-home-city-0001",
      undoTtlMs: 60_000
    };
    const receipt = await store.forgetOwnerMemory("owner", input);
    expect(receipt).toMatchObject({
      after: { deleted: true, version: 2 },
      before: { value: "Seoul", version: 1 },
      operation: "forget"
    });
    await expect(store.forgetOwnerMemory("owner", input)).resolves.toEqual(receipt);
    await expect(store.forgetOwnerMemory("owner", {
      ...input,
      requestId: "forget-home-city-retry"
    })).rejects.toSatisfy(expectControlError("not-found"));
    await expect(store.previewOwnerMemory("owner", entry.exactId)).rejects.toSatisfy(
      expectControlError("not-found")
    );

    const restored = await store.undoOwnerMemory("owner", receipt.receiptId);
    expect(restored.status).toBe("undone");
    expect(await store.previewOwnerMemory("owner", entry.exactId)).toMatchObject({
      value: "Seoul",
      version: 3
    });
  });

  it("fails closed at the expiry boundary and when a newer write changed the receipt's after-state", async () => {
    const expiryFixture = await fixture();
    await expiryFixture.store.upsertFact("owner", "city", "Seoul");
    const expiryEntry = (await expiryFixture.store.inspectOwnerMemory("owner"))[0]!;
    const expiring = await expiryFixture.store.correctOwnerMemory("owner", {
      exactId: expiryEntry.exactId,
      expectedVersion: 1,
      requestId: "expiry-correction-0001",
      undoTtlMs: 1_000,
      value: "Busan"
    });
    expiryFixture.setNow(expiring.expiresAt);
    await expect(expiryFixture.store.undoOwnerMemory("owner", expiring.receiptId))
      .rejects.toSatisfy(expectControlError("expired"));
    expect((await expiryFixture.store.findByUserId("owner"))?.facts.city).toBe("Busan");

    const conflictFixture = await fixture();
    await conflictFixture.store.upsertFact("owner", "city", "Seoul");
    const conflictEntry = (await conflictFixture.store.inspectOwnerMemory("owner"))[0]!;
    const receipt = await conflictFixture.store.correctOwnerMemory("owner", {
      exactId: conflictEntry.exactId,
      expectedVersion: 1,
      requestId: "conflict-correction-0001",
      value: "Busan"
    });
    await conflictFixture.store.upsertFact("owner", "city", "Incheon");
    await expect(conflictFixture.store.undoOwnerMemory("owner", receipt.receiptId))
      .rejects.toSatisfy(expectControlError("conflict"));
    expect((await conflictFixture.store.previewOwnerMemory("owner", conflictEntry.exactId))).toMatchObject({
      value: "Incheon",
      version: 3
    });
  });

  it("atomically removes an expired forget receipt and its only recovery copy", async () => {
    const { file, setNow, store } = await fixture();
    const secret = "EXPIRED-FORGET-RECOVERY-ONLY-9f1b";
    await store.upsertFact("owner", "temporary_secret", secret);
    const entry = (await store.inspectOwnerMemory("owner"))[0]!;
    const receipt = await store.forgetOwnerMemory("owner", {
      exactId: entry.exactId,
      expectedVersion: 1,
      requestId: "expiring-forget-secret-0001",
      undoTtlMs: 1_000
    });
    expect(await readFile(file, "utf8")).toContain(secret);

    setNow(receipt.expiresAt);
    await expect(store.undoOwnerMemory("owner", receipt.receiptId))
      .rejects.toSatisfy(expectControlError("expired"));
    const after = await readFile(file, "utf8");
    expect(after).not.toContain(secret);
    const parsed = JSON.parse(after) as {
      users: { owner: { ownerControl: { mutationReceipts: unknown[] } } };
    };
    expect(parsed.users.owner.ownerControl.mutationReceipts).toEqual([]);
    expect((await store.findByUserId("owner"))?.facts.temporary_secret).toBeUndefined();
  });

  it("scope-binds receipt IDs so an expired request ID cannot alias a later target", async () => {
    const { setNow, store } = await fixture();
    await store.upsertFact("owner", "a", "A0");
    const a = (await store.inspectOwnerMemory("owner"))[0]!;
    const reusedRequestId = "reused-after-expiry-0001";
    const oldReceipt = await store.forgetOwnerMemory("owner", {
      exactId: a.exactId,
      expectedVersion: 1,
      requestId: reusedRequestId,
      undoTtlMs: 1
    });
    setNow(oldReceipt.expiresAt);
    await expect(store.undoOwnerMemory("owner", oldReceipt.receiptId))
      .rejects.toSatisfy(expectControlError("expired"));

    await store.upsertFact("owner", "b", "B0");
    const b = (await store.inspectOwnerMemory("owner")).find((entry) => entry.key === "b")!;
    const newReceipt = await store.forgetOwnerMemory("owner", {
      exactId: b.exactId,
      expectedVersion: b.version,
      requestId: reusedRequestId
    });
    expect(newReceipt.receiptId).not.toBe(oldReceipt.receiptId);
    await expect(store.undoOwnerMemory("owner", oldReceipt.receiptId))
      .rejects.toSatisfy(expectControlError("not-found"));
    expect((await store.findByUserId("owner"))?.facts.b).toBeUndefined();
    await store.undoOwnerMemory("owner", newReceipt.receiptId);
    expect((await store.findByUserId("owner"))?.facts.b).toBe("B0");
  });

  it("rejects receipts whose target ID was rebound to another valid entry", async () => {
    const { file, store } = await fixture();
    await store.upsertFact("owner", "city", "Seoul");
    await store.upsertFact("owner", "timezone", "Asia/Seoul");
    const entries = await store.inspectOwnerMemory("owner");
    const city = entries.find((entry) => entry.key === "city")!;
    const timezone = entries.find((entry) => entry.key === "timezone")!;
    const receipt = await store.correctOwnerMemory("owner", {
      exactId: city.exactId,
      expectedVersion: 1,
      requestId: "semantic-binding-0001",
      value: "Busan"
    });
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      users: {
        owner: {
          ownerControl: {
            mutationReceipts: Array<{ target: { exactId: string } }>;
          };
        };
      };
    };
    parsed.users.owner.ownerControl.mutationReceipts[0]!.target.exactId = timezone.exactId;
    await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    const before = await readFile(file, "utf8");

    await expect(store.undoOwnerMemory("owner", receipt.receiptId))
      .rejects.toSatisfy(expectControlError("corrupt-control-state"));
    await expect(store.inspectOwnerMemory("owner"))
      .rejects.toSatisfy(expectControlError("corrupt-control-state"));
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("does not ambiguously expose the legacy default bucket through arbitrary owner aliases", async () => {
    const { file } = await fixture();
    const defaultStore = new FileUserMemoryStore({ file });
    await defaultStore.upsertFact("default", "private_note", "only-default-may-control-this");

    expect(await defaultStore.inspectOwnerMemory("alice")).toEqual([]);
    expect(await defaultStore.inspectOwnerMemory("bob")).toEqual([]);
    expect(await defaultStore.inspectOwnerMemory("default")).toHaveLength(1);
    expect((await defaultStore.findByUserId("alice"))?.facts.private_note).toBe(
      "only-default-may-control-this"
    );
  });

  it("rejects stale versions, request-ID scope changes, and concurrent clobber attempts", async () => {
    const { store } = await fixture();
    await store.upsertFact("owner", "city", "Seoul");
    const entry = (await store.inspectOwnerMemory("owner"))[0]!;
    const results = await Promise.allSettled([
      store.correctOwnerMemory("owner", {
        exactId: entry.exactId,
        expectedVersion: 1,
        requestId: "concurrent-correction-a",
        value: "Busan"
      }),
      store.correctOwnerMemory("owner", {
        exactId: entry.exactId,
        expectedVersion: 1,
        requestId: "concurrent-correction-b",
        value: "Incheon"
      })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "conflict" }
    });

    const applied = results.find((result) => result.status === "fulfilled")!;
    if (applied.status !== "fulfilled") throw new Error("unreachable");
    await expect(store.forgetOwnerMemory("owner", {
      exactId: entry.exactId,
      expectedVersion: 1,
      requestId: applied.value.requestId
    })).rejects.toSatisfy(expectControlError("request-reused"));
  });

  it("refuses corrupt owner-control metadata without changing the file", async () => {
    const { file, store } = await fixture();
    await store.upsertFact("owner", "city", "Seoul");
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      users: { owner: { ownerControl: { entryVersions: Record<string, unknown> } } };
    };
    const exactId = exactUserMemoryId("owner", "fact", "city");
    parsed.users.owner.ownerControl.entryVersions[exactId] = 0;
    await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    const before = await readFile(file, "utf8");

    await expect(store.previewOwnerMemory("owner", exactId))
      .rejects.toSatisfy(expectControlError("corrupt-control-state"));
    await expect(store.correctOwnerMemory("owner", {
      exactId,
      expectedVersion: 1,
      requestId: "corrupt-correction-0001",
      value: "Busan"
    })).rejects.toSatisfy(expectControlError("corrupt-control-state"));
    expect(await readFile(file, "utf8")).toBe(before);
  });
});
