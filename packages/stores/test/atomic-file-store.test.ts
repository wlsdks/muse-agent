import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWriteFile, withFileMutationQueue } from "../src/atomic-file-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-atomic-"));
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("atomicWriteFile", () => {
  it("writes the contents, creating nested directories, and leaves no temp file", async () => {
    const file = join(dir, "nested", "deep", "x.json");
    await atomicWriteFile(file, "hello");
    expect(await readFile(file, "utf8")).toBe("hello");
    expect((await readdir(join(dir, "nested", "deep"))).filter((e) => e.includes(".tmp"))).toEqual([]);
  });

  it("writes with 0600 permissions by default and honours an explicit mode", async () => {
    const a = join(dir, "a");
    await atomicWriteFile(a, "x");
    expect((await stat(a)).mode & 0o777).toBe(0o600);
    const b = join(dir, "b");
    await atomicWriteFile(b, "x", { mode: 0o644 });
    expect((await stat(b)).mode & 0o777).toBe(0o644);
  });

  it("overwrites an existing file atomically", async () => {
    const file = join(dir, "c");
    await writeFile(file, "old", "utf8");
    await atomicWriteFile(file, "new");
    expect(await readFile(file, "utf8")).toBe("new");
  });

  it("still writes correctly with fsync disabled", async () => {
    const file = join(dir, "d");
    await atomicWriteFile(file, "nofsync", { fsync: false });
    expect(await readFile(file, "utf8")).toBe("nofsync");
  });

  it("survives many CONCURRENT writes to one file without an ENOENT rename crash (randomUUID tmp)", async () => {
    // The old `${pid}-${Date.now()}` tmp name collided under concurrency → one rename hit ENOENT.
    const file = join(dir, "race.json");
    await Promise.all(Array.from({ length: 40 }, (_unused, i) => atomicWriteFile(file, `payload-${i.toString()}`)));
    const final = await readFile(file, "utf8");
    expect(final.startsWith("payload-")).toBe(true); // some writer won cleanly; none crashed
  });

  it("removes the tmp orphan when the write/rename fails (no litter left in the store dir)", async () => {
    // Force the rename to fail: the target path is an existing DIRECTORY, so
    // rename(tmp, target) throws. The tmp must not be left behind as litter.
    const target = join(dir, "store.json");
    await mkdir(target);
    await expect(atomicWriteFile(target, '{"x":1}')).rejects.toBeTruthy();
    expect((await readdir(dir)).filter((e) => e.includes(".tmp-"))).toEqual([]);
  });
});

describe("withFileMutationQueue", () => {
  it("SERIALISES concurrent read-modify-write so no update is lost (the core lost-update fix)", async () => {
    const file = join(dir, "counter");
    await atomicWriteFile(file, "0");
    const readNum = async () => Number(await readFile(file, "utf8"));
    // each op reads, yields (exposing the race a naive impl would lose), then writes back +1
    const increment = () => withFileMutationQueue(file, async () => {
      const cur = await readNum();
      await new Promise((resolve) => setTimeout(resolve, 0)); // force interleaving
      await atomicWriteFile(file, String(cur + 1));
    });
    await Promise.all(Array.from({ length: 25 }, increment));
    expect(await readNum()).toBe(25); // serialised → every increment landed
  });

  it("runs different files in parallel (the queue is keyed by path)", async () => {
    const order: string[] = [];
    const slow = withFileMutationQueue(join(dir, "f1"), async () => { await new Promise((r) => setTimeout(r, 20)); order.push("slow"); });
    const fast = withFileMutationQueue(join(dir, "f2"), async () => { order.push("fast"); });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["fast", "slow"]); // f2 didn't wait behind f1
  });

  it("rejects the caller's promise on a throwing op WITHOUT wedging the queue for the next op", async () => {
    const file = join(dir, "q");
    await expect(withFileMutationQueue(file, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // the queue must still accept and run the next op on the same file
    await expect(withFileMutationQueue(file, async () => 42)).resolves.toBe(42);
  });

  it("returns the op's value", async () => {
    expect(await withFileMutationQueue(join(dir, "r"), async () => ({ ok: true }))).toEqual({ ok: true });
  });
});
