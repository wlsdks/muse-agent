/**
 * Coverage for the proactive-tick activity trackers — both the
 * in-memory implementation (single-process default) and the
 * file-backed implementation (multi-process / multi-device).
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFileBackedActivityTracker,
  createInMemoryActivityTracker
} from "../src/proactive-tick.js";

describe("createInMemoryActivityTracker", () => {
  it("starts undefined and tracks the latest record() call", () => {
    const tracker = createInMemoryActivityTracker();
    expect(tracker.lastActivityMs()).toBeUndefined();
    tracker.record(100);
    expect(tracker.lastActivityMs()).toBe(100);
    tracker.record(200);
    expect(tracker.lastActivityMs()).toBe(200);
  });

  it("defaults to Date.now() when record() is called without args", () => {
    const tracker = createInMemoryActivityTracker();
    const before = Date.now();
    tracker.record();
    const after = Date.now();
    const recorded = tracker.lastActivityMs();
    expect(recorded).toBeDefined();
    expect(recorded! >= before && recorded! <= after).toBe(true);
  });
});

describe("createFileBackedActivityTracker", () => {
  it("returns undefined when the file does not yet exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-presence-"));
    const file = join(dir, "presence.json");
    const tracker = createFileBackedActivityTracker({ file });
    expect(tracker.lastActivityMs()).toBeUndefined();
  });

  it("debounces writes and exposes the in-flight value before the flush", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-presence-debounce-"));
    const file = join(dir, "presence.json");
    let virtualNow = 1_000_000;
    const tracker = createFileBackedActivityTracker({
      debounceMs: 50,
      file,
      now: () => virtualNow
    });
    tracker.record(virtualNow);
    // First record flushes synchronously (no prior write).
    const persisted = JSON.parse(await readFile(file, "utf8")) as { lastActivityMs: number };
    expect(persisted.lastActivityMs).toBe(virtualNow);

    // Within the debounce window the second record() does NOT
    // flush again — but lastActivityMs() must still reflect the
    // newer value (in-flight pending wins over cached disk read).
    virtualNow = 1_000_010;
    tracker.record(virtualNow);
    expect(tracker.lastActivityMs()).toBe(virtualNow);
    const disk2 = JSON.parse(await readFile(file, "utf8")) as { lastActivityMs: number };
    expect(disk2.lastActivityMs).toBe(1_000_000); // still the first write
  });

  it("a second tracker pointing at the same file reads the persisted value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-presence-share-"));
    const file = join(dir, "presence.json");
    const virtualNow = 5_000_000;
    const trackerA = createFileBackedActivityTracker({
      debounceMs: 10,
      file,
      now: () => virtualNow
    });
    trackerA.record(virtualNow);
    // Daemon-side tracker reads through the shared file.
    const trackerB = createFileBackedActivityTracker({ file });
    expect(trackerB.lastActivityMs()).toBe(virtualNow);
  });

  it("survives a corrupt file by treating it as never-recorded", async () => {
    const { writeFile } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "muse-presence-corrupt-"));
    const file = join(dir, "presence.json");
    await writeFile(file, "not json", "utf8");
    const tracker = createFileBackedActivityTracker({ file });
    expect(tracker.lastActivityMs()).toBeUndefined();
  });
});
