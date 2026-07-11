import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendDigestItem, drainDigestQueue, readDigestQueue } from "../src/digest-queue.js";

const NOW = new Date("2026-07-11T12:00:00.000Z");

describe("readDigestQueue — tolerant reads", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), `muse-digest-${randomUUID()}-`)); file = join(dir, "queue.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("missing file -> empty array", async () => {
    expect(await readDigestQueue(file)).toEqual([]);
  });

  it("malformed JSON -> empty array (does not throw)", async () => {
    await writeFile(file, "not json at all", "utf8");
    expect(await readDigestQueue(file)).toEqual([]);
  });

  it("wrong shape (missing queued array) -> empty array", async () => {
    await writeFile(file, JSON.stringify({ items: [] }), "utf8");
    expect(await readDigestQueue(file)).toEqual([]);
  });

  it("one corrupt row does not sink the whole file — valid rows survive", async () => {
    await writeFile(
      file,
      JSON.stringify({
        queued: [
          { at: NOW.toISOString(), source: "ambient-notice", text: "reminder text" },
          { source: "missing-at-and-text" },
          42
        ]
      }),
      "utf8"
    );
    const queue = await readDigestQueue(file);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ source: "ambient-notice", text: "reminder text" });
  });
});

describe("appendDigestItem", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), `muse-digest-${randomUUID()}-`)); file = join(dir, "queue.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("appends an item with the given fields and ISO timestamp", async () => {
    await appendDigestItem(file, { at: NOW, source: "pattern-firing", sourceId: "pat-1", text: "you usually leave by 5pm" });
    const queue = await readDigestQueue(file);
    expect(queue).toEqual([{ at: NOW.toISOString(), source: "pattern-firing", sourceId: "pat-1", text: "you usually leave by 5pm" }]);
  });

  it("omits sourceId entirely when not given (no stray undefined field)", async () => {
    await appendDigestItem(file, { at: NOW, source: "commitment-checkin", text: "checking in on your goal" });
    const queue = await readDigestQueue(file);
    expect(queue[0]).not.toHaveProperty("sourceId");
  });

  it("normalizes text to a single line on append — collapses newlines and repeated whitespace, trims ends", async () => {
    await appendDigestItem(file, { at: NOW, source: "followup-firing", text: "  line one\n\nline two\t\tline three  " });
    const queue = await readDigestQueue(file);
    expect(queue[0]!.text).toBe("line one line two line three");
  });

  it("serializes concurrent appends — no lost item, no rename crash", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_u, i) =>
        appendDigestItem(file, { at: new Date(NOW.getTime() + i), source: `s${i.toString()}`, text: `item ${i.toString()}` })
      )
    );
    const queue = await readDigestQueue(file);
    expect(queue).toHaveLength(25);
    expect(new Set(queue.map((item) => item.source)).size).toBe(25);
  }, 30_000);
});

describe("drainDigestQueue — atomic removal", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), `muse-digest-${randomUUID()}-`)); file = join(dir, "queue.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("with no upToAt, removes everything", async () => {
    await appendDigestItem(file, { at: NOW, source: "a", text: "one" });
    await appendDigestItem(file, { at: new Date(NOW.getTime() + 1_000), source: "b", text: "two" });
    await drainDigestQueue(file);
    expect(await readDigestQueue(file)).toEqual([]);
  });

  it("with upToAt, removes only entries at or before the cutoff — later entries survive", async () => {
    const early = new Date(NOW.getTime() - 60_000);
    const atCutoff = NOW;
    const late = new Date(NOW.getTime() + 60_000);
    await appendDigestItem(file, { at: early, source: "a", text: "early" });
    await appendDigestItem(file, { at: atCutoff, source: "b", text: "at-cutoff" });
    await appendDigestItem(file, { at: late, source: "c", text: "late" });

    await drainDigestQueue(file, NOW);

    const remaining = await readDigestQueue(file);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ source: "c" });
  });

  it("draining an empty queue is a no-op (does not throw)", async () => {
    await expect(drainDigestQueue(file)).resolves.toBeUndefined();
    expect(await readDigestQueue(file)).toEqual([]);
  });

  it("an append landing after the compiled upToAt (mid-flush) is never dropped", async () => {
    const compileTime = NOW;
    await appendDigestItem(file, { at: new Date(compileTime.getTime() - 1_000), source: "compiled", text: "was compiled" });
    // Simulates an item queued WHILE the flush is compiling/sending, after upToAt was captured.
    await appendDigestItem(file, { at: new Date(compileTime.getTime() + 5_000), source: "mid-flush", text: "arrived mid flush" });

    await drainDigestQueue(file, compileTime);

    const remaining = await readDigestQueue(file);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ source: "mid-flush" });
  });
});
