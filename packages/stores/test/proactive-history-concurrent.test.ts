import { randomUUID } from "node:crypto";
import { rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";

import { appendProactiveHistory, readProactiveHistory, type ProactiveHistoryEntry } from "../src/personal-proactive-history-store.js";

let files: string[] = [];
const freshFile = () => {
  const file = join(tmpdir(), `muse-proactive-history-${randomUUID()}.json`);
  files.push(file);
  return file;
};
afterEach(async () => { await Promise.all(files.map((f) => rm(f, { force: true }))); files = []; });

const entry = (itemId: string): ProactiveHistoryEntry => ({
  destination: "555",
  firedAtIso: "2026-06-01T00:00:01Z",
  itemId,
  kind: "task",
  providerId: "telegram",
  startIso: "2026-06-01T00:00:00Z",
  status: "delivered",
  text: `delivered ${itemId}`,
  title: `t-${itemId}`
});

// appendProactiveHistory is a read-modify-write. Before it was put on the shared
// per-file mutation queue, concurrent appends BOTH read the same snapshot and the
// last write clobbered the rest (a lost proactive-history entry corrupts the
// trust-ledger precision), AND collided on the same `tmp-${pid}-${Date.now()}`
// path within one millisecond — which threw ENOENT on rename, crashing the append.
describe("appendProactiveHistory under concurrency", () => {
  it("reads after an external lock releases so it preserves another process's audit entry", async () => {
    const file = freshFile();
    await appendProactiveHistory(file, entry("seed"));
    const lockPath = `${file}.lock`;
    await writeFile(lockPath, "external-holder", "utf8");

    const pending = appendProactiveHistory(file, entry("local"));
    await sleep(300);
    await writeFile(file, JSON.stringify({ entries: [entry("seed"), entry("external")], version: 1 }), "utf8");
    await unlink(lockPath);
    await pending;

    expect((await readProactiveHistory(file)).map((value) => value.itemId).sort()).toEqual(["external", "local", "seed"]);
  }, 10_000);

  it("normalizes non-finite archive limits and drops malformed optional errors", async () => {
    const file = freshFile();
    await appendProactiveHistory(file, entry("safe"), { archiveMaxFiles: Number.POSITIVE_INFINITY });
    await writeFile(file, JSON.stringify({ entries: [entry("valid"), { ...entry("invalid"), error: 7 }], version: 1 }), "utf8");
    expect((await readProactiveHistory(file)).map((value) => value.itemId)).toEqual(["valid"]);
  });

  it("preserves EVERY entry recorded concurrently (no lost update, no rename crash)", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 25 }, (_unused, i) => appendProactiveHistory(file, entry(`p${i.toString()}`), { capacity: 100 })));
    const all = await readProactiveHistory(file);
    expect(all).toHaveLength(25);
    expect(new Set(all.map((e) => e.itemId)).size).toBe(25);
  }, 30_000);

  it("still honours the capacity cap (newest kept) under concurrent over-cap appends", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 30 }, (_unused, i) => appendProactiveHistory(file, entry(`q${i.toString()}`), { capacity: 10 })));
    expect(await readProactiveHistory(file)).toHaveLength(10); // capped, not over-cap, not lost-to-stale
  }, 30_000);
});
