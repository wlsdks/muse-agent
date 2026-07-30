import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTriggerEnvelope, serializeTriggerAdmissionJournal } from "@muse/shared";
import { afterEach, describe, expect, it } from "vitest";

import { FileTriggerAdmissionJournalStore } from "../src/trigger-admission-journal-store.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const tempRoots: string[] = [];

async function journalFile(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "muse-trigger-journal-"));
  tempRoots.push(root);
  return join(root, "trigger-admission.json");
}

function envelope(generation: string) {
  return createTriggerEnvelope({
    generation,
    occurredAt: NOW,
    receivedAt: NOW,
    source: "cron",
    sourceId: "daily-brief"
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    fs.rm(root, { force: true, recursive: true })
  ));
});

describe("FileTriggerAdmissionJournalStore", () => {
  it("starts missing state empty and writes owner-only durable state", async () => {
    const file = await journalFile();
    const store = new FileTriggerAdmissionJournalStore({ file, maxPending: 2 });

    expect(await store.read()).toMatchObject({ entries: [], maxPending: 2 });
    const admission = await store.admit({ envelope: envelope("g1"), now: NOW });

    expect(admission.decision.action).toBe("execute");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await store.read()).toEqual(admission.journal);
  });

  it("preserves admission and settlement across fresh store instances", async () => {
    const file = await journalFile();
    const first = new FileTriggerAdmissionJournalStore({ file, maxPending: 2 });
    const admission = await first.admit({ envelope: envelope("g1"), now: NOW });

    const second = new FileTriggerAdmissionJournalStore({ file, maxPending: 2 });
    await second.settle({
      at: new Date("2026-07-30T12:00:01.000Z"),
      dedupKey: admission.decision.dedupKey!,
      outcome: "completed"
    });

    const restored = await new FileTriggerAdmissionJournalStore({
      file,
      maxPending: 2
    }).read();
    expect(restored.entries).toMatchObject([{ state: "completed" }]);
  });

  it("serializes concurrent duplicate admission across store instances", async () => {
    const file = await journalFile();
    const stores = [
      new FileTriggerAdmissionJournalStore({ file, maxPending: 2 }),
      new FileTriggerAdmissionJournalStore({ file, maxPending: 2 })
    ];

    const results = await Promise.all(stores.map((store) =>
      store.admit({ envelope: envelope("same-generation"), now: NOW })
    ));

    expect(results.map((result) => result.decision.action).sort()).toEqual(["execute", "reject"]);
    expect(results.filter((result) => result.recorded)).toHaveLength(1);
    expect((await stores[0]!.read()).entries).toHaveLength(1);
  });

  it("fails closed on corrupt state without replacing the original bytes", async () => {
    const file = await journalFile();
    const corrupt = "{\"schemaVersion\":1,\"entries\":[]}";
    await fs.writeFile(file, corrupt, "utf8");
    const store = new FileTriggerAdmissionJournalStore({ file, maxPending: 2 });

    await expect(store.read()).rejects.toThrow(/invalid trigger admission journal/u);
    await expect(store.admit({ envelope: envelope("g1"), now: NOW })).rejects.toThrow(
      /invalid trigger admission journal/u
    );
    expect(await fs.readFile(file, "utf8")).toBe(corrupt);
  });

  it("fails closed on oversized state without replacing it", async () => {
    const file = await journalFile();
    const oversized = "x".repeat(257);
    await fs.writeFile(file, oversized, "utf8");
    const store = new FileTriggerAdmissionJournalStore({
      file,
      maxFileBytes: 256,
      maxPending: 2
    });

    await expect(store.admit({ envelope: envelope("g1"), now: NOW })).rejects.toThrow(
      /exceeds maxFileBytes/u
    );
    expect(await fs.readFile(file, "utf8")).toBe(oversized);
  });

  it("fails closed on a symlink without changing its target", async () => {
    const file = await journalFile();
    const target = join(file, "..", "target.json");
    const initialStore = new FileTriggerAdmissionJournalStore({
      file: target,
      maxPending: 2
    });
    await initialStore.admit({ envelope: envelope("existing"), now: NOW });
    const before = await fs.readFile(target, "utf8");
    await fs.symlink(target, file);

    const store = new FileTriggerAdmissionJournalStore({ file, maxPending: 2 });
    await expect(store.admit({ envelope: envelope("g1"), now: NOW })).rejects.toThrow(
      /regular file/u
    );
    expect(await fs.readFile(target, "utf8")).toBe(before);
  });

  it("does not rewrite an exact replay", async () => {
    const file = await journalFile();
    const store = new FileTriggerAdmissionJournalStore({ file, maxPending: 2 });
    await store.admit({ envelope: envelope("g1"), now: NOW });
    const before = await fs.readFile(file, "utf8");

    const replay = await store.admit({ envelope: envelope("g1"), now: NOW });

    expect(replay).toMatchObject({
      decision: { action: "reject", reasons: ["duplicate"] },
      recorded: false
    });
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("rejects invalid capacity before any filesystem effect", async () => {
    const file = await journalFile();

    expect(() => new FileTriggerAdmissionJournalStore({
      file,
      maxEntries: 1,
      maxPending: 2
    })).toThrow(/maxEntries/u);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits a parser-compatible snapshot", async () => {
    const file = await journalFile();
    const store = new FileTriggerAdmissionJournalStore({ file, maxPending: 2 });
    await store.admit({ envelope: envelope("g1"), now: NOW });

    expect((await fs.readFile(file, "utf8")).trim()).toBe(
      serializeTriggerAdmissionJournal(await store.read())
    );
  });
});
