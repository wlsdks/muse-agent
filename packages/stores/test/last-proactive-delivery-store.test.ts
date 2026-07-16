import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendLastProactiveDelivery, readLastProactiveDeliveries } from "../src/last-proactive-delivery-store.js";

const NOW = new Date("2026-07-12T09:00:00.000Z");

describe("readLastProactiveDeliveries — tolerant reads", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), `muse-last-delivery-${randomUUID()}-`)); file = join(dir, "last.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("missing file -> empty array", async () => {
    expect(await readLastProactiveDeliveries(file)).toEqual([]);
  });

  it("malformed JSON -> empty array (does not throw)", async () => {
    await writeFile(file, "not json at all", "utf8");
    expect(await readLastProactiveDeliveries(file)).toEqual([]);
  });

  it("wrong shape (missing deliveries array) -> empty array", async () => {
    await writeFile(file, JSON.stringify({ entries: [] }), "utf8");
    expect(await readLastProactiveDeliveries(file)).toEqual([]);
  });

  it("one corrupt row does not sink the whole file — valid rows survive", async () => {
    await writeFile(
      file,
      JSON.stringify({
        deliveries: [
          { at: NOW.toISOString(), outcome: "delivered", sourceKey: "pattern-firing:p1" },
          { sourceKey: "missing-at-and-outcome" },
          { at: NOW.toISOString(), outcome: "not-a-real-outcome", sourceKey: "bad-outcome" },
          42
        ]
      }),
      "utf8"
    );
    const entries = await readLastProactiveDeliveries(file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "delivered", sourceKey: "pattern-firing:p1" });
  });
});

describe("appendLastProactiveDelivery", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), `muse-last-delivery-${randomUUID()}-`)); file = join(dir, "last.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("appends an entry with the given fields and ISO timestamp", async () => {
    await appendLastProactiveDelivery(file, { at: NOW, outcome: "delivered", sourceKey: "followup:fu-1", title: "prep for interview" });
    const entries = await readLastProactiveDeliveries(file);
    expect(entries).toEqual([{ at: NOW.toISOString(), outcome: "delivered", sourceKey: "followup:fu-1", title: "prep for interview" }]);
  });

  it("omits title entirely when not given (no stray undefined field)", async () => {
    await appendLastProactiveDelivery(file, { at: NOW, outcome: "digested", sourceKey: "ambient-notice:rule-1" });
    const entries = await readLastProactiveDeliveries(file);
    expect(entries[0]).not.toHaveProperty("title");
  });

  it("records both delivered and digested outcomes", async () => {
    await appendLastProactiveDelivery(file, { at: NOW, outcome: "delivered", sourceKey: "a" });
    await appendLastProactiveDelivery(file, { at: new Date(NOW.getTime() + 1_000), outcome: "digested", sourceKey: "b" });
    const entries = await readLastProactiveDeliveries(file);
    expect(entries.map((e) => e.outcome)).toEqual(["delivered", "digested"]);
  });

  it("is bounded to the newest 20 entries — oldest trimmed first, append order preserved", async () => {
    for (let i = 0; i < 25; i += 1) {
      await appendLastProactiveDelivery(file, { at: new Date(NOW.getTime() + i), outcome: "delivered", sourceKey: `source-${i.toString()}` });
    }
    const entries = await readLastProactiveDeliveries(file);
    expect(entries).toHaveLength(20);
    expect(entries[0]!.sourceKey).toBe("source-5");
    expect(entries[19]!.sourceKey).toBe("source-24");
  });

  it("writes the sidecar 0o600 (owner-only — personal delivery data)", async () => {
    await appendLastProactiveDelivery(file, { at: NOW, outcome: "delivered", sourceKey: "a" });
    const mode = (await stat(file)).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("serializes concurrent appends — no lost entry, no rename crash", async () => {
    await Promise.all(
      Array.from({ length: 15 }, (_u, i) =>
        appendLastProactiveDelivery(file, { at: new Date(NOW.getTime() + i), outcome: "delivered", sourceKey: `s${i.toString()}` })
      )
    );
    const entries = await readLastProactiveDeliveries(file);
    expect(entries).toHaveLength(15);
    expect(new Set(entries.map((e) => e.sourceKey)).size).toBe(15);
  }, 30_000);

  it("preserves an external delivery committed while this process waits for the file lock", async () => {
    await appendLastProactiveDelivery(file, { at: NOW, outcome: "delivered", sourceKey: "local-first" });
    await writeFile(`${file}.lock`, "external writer", { flag: "wx" });
    const localDelivery = appendLastProactiveDelivery(file, { at: new Date(NOW.getTime() + 2_000), outcome: "delivered", sourceKey: "local-second" });
    await sleep(300);
    const first = (await readLastProactiveDeliveries(file))[0]!;
    await writeFile(file, `${JSON.stringify({ deliveries: [first, { at: new Date(NOW.getTime() + 1_000).toISOString(), outcome: "digested", sourceKey: "external" }] }, null, 2)}\n`);
    await unlink(`${file}.lock`);

    await localDelivery;
    expect((await readLastProactiveDeliveries(file)).map(({ sourceKey }) => sourceKey)).toEqual(["local-first", "external", "local-second"]);
  });
});
