import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-atomic-")); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

describe("atomicWriteFile", () => {
  it("writes the contents and creates parent directories", async () => {
    const file = join(dir, "nested", "deep", "x.json");
    await atomicWriteFile(file, '{"a":1}\n');
    expect(await readFile(file, "utf8")).toBe('{"a":1}\n');
  });

  it("overwrites atomically (the final file is the last full write, no tmp left behind)", async () => {
    const file = join(dir, "x.json");
    await atomicWriteFile(file, "first");
    await atomicWriteFile(file, "second");
    expect(await readFile(file, "utf8")).toBe("second");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(dir)).filter((n) => n.includes(".tmp-"))).toEqual([]); // no leftover tmp
  });

  it("survives many CONCURRENT writes to one file without an ENOENT rename crash (randomUUID tmp)", async () => {
    const file = join(dir, "race.json");
    // The old `${pid}-${Date.now()}` tmp name collided here → one rename hit ENOENT.
    await Promise.all(Array.from({ length: 40 }, (_unused, i) => atomicWriteFile(file, `payload-${i.toString()}`)));
    const final = await readFile(file, "utf8");
    expect(final.startsWith("payload-")).toBe(true); // some writer won cleanly; none crashed
  });
});

describe("withFileMutationQueue", () => {
  it("serialises read-modify-write so concurrent increments are not lost", async () => {
    const file = join(dir, "counter.json");
    await atomicWriteFile(file, JSON.stringify({ n: 0 }));
    const bump = () => withFileMutationQueue(file, async () => {
      const n = JSON.parse(await readFile(file, "utf8")).n as number;
      await atomicWriteFile(file, JSON.stringify({ n: n + 1 }));
    });
    await Promise.all(Array.from({ length: 30 }, bump));
    expect(JSON.parse(await readFile(file, "utf8")).n).toBe(30); // not last-writer-wins (would be 1)
  });

  it("runs different files in PARALLEL (the queue is per-file, not global)", async () => {
    const order: string[] = [];
    await Promise.all([
      withFileMutationQueue(join(dir, "a"), async () => { await new Promise((r) => setTimeout(r, 15)); order.push("a"); }),
      withFileMutationQueue(join(dir, "b"), async () => { order.push("b"); }), // must not wait on a's 15ms
    ]);
    expect(order).toEqual(["b", "a"]); // b (no delay) finishes first → not serialised behind a
  });

  it("a throwing op rejects its own promise but does NOT wedge the queue for the next op", async () => {
    const file = join(dir, "q.json");
    await expect(withFileMutationQueue(file, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withFileMutationQueue(file, async () => "ok")).resolves.toBe("ok"); // queue recovered
  });

  it("returns the op's value", async () => {
    expect(await withFileMutationQueue(join(dir, "v"), async () => 42)).toBe(42);
  });
});
