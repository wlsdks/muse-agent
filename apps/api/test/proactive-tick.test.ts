/**
 * Coverage for the proactive-tick activity trackers — both the
 * in-memory implementation (single-process default) and the
 * file-backed implementation (multiple processes on one filesystem).
 */

import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";
import { withFileLock } from "@muse/stores";

import {
  createFileBackedActivityTracker,
  createInMemoryActivityTracker
} from "../src/proactive-tick.js";

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(file);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

interface PresenceWriterProcess {
  readonly completion: Promise<void>;
  readonly kill: () => void;
}

function startPresenceWriter(args: readonly string[]): PresenceWriterProcess {
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  const childFile = fileURLToPath(new URL("./fixtures/presence-writer.ts", import.meta.url));
  const child = spawn(process.execPath, [tsxCli, childFile, ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`presence writer exited ${String(code)}: ${stderr}`)));
  });
  return {
    completion,
    kill: () => { child.kill(); }
  };
}

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

  it("keeps its valid high-water when explicit records are older, negative, non-finite, or future", () => {
    let nowMs = 1_000;
    const tracker = createInMemoryActivityTracker({ now: () => nowMs });
    tracker.record(800);
    tracker.record(700);
    tracker.record(-1);
    tracker.record(Number.NaN);
    tracker.record(Number.POSITIVE_INFINITY);
    tracker.record(1_001);
    expect(tracker.lastActivityMs()).toBe(800);

    nowMs = 1_100;
    tracker.record();
    expect(tracker.lastActivityMs()).toBe(1_100);
  });
});

describe("createFileBackedActivityTracker", () => {
  it("returns undefined when the file does not yet exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-presence-"));
    const file = join(dir, "presence.json");
    const tracker = createFileBackedActivityTracker({ file });
    expect(tracker.lastActivityMs()).toBeUndefined();
  });

  it("debounces writes, returns immediately, and exposes the in-flight value before the flush", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-presence-debounce-"));
    const file = join(dir, "presence.json");
    let virtualNow = 1_000_000;
    const tracker = createFileBackedActivityTracker({
      debounceMs: 50,
      file,
      now: () => virtualNow
    });
    await tracker.record(virtualNow);
    // First record flushes synchronously (no prior write).
    const persisted = JSON.parse(await readFile(file, "utf8")) as { lastActivityMs: number };
    expect(persisted.lastActivityMs).toBe(virtualNow);

    // Within the debounce window the second record() does NOT
    // flush again — but lastActivityMs() must still reflect the
    // newer value (in-flight pending wins over cached disk read).
    virtualNow = 1_000_010;
    await tracker.record(virtualNow);
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
    await trackerA.record(virtualNow);
    // Daemon-side tracker reads through the shared file.
    const trackerB = createFileBackedActivityTracker({ file });
    expect(trackerB.lastActivityMs()).toBe(virtualNow);
  });

  it("serializes simultaneous child writers behind the shared file lock and keeps their maximum", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-presence-process-race-"));
    const file = join(dir, "presence.json");
    const barrier = join(dir, "go");
    const highReady = join(dir, "high.ready");
    const lowReady = join(dir, "low.ready");
    const highAttempting = join(dir, "high.attempting");
    const lowAttempting = join(dir, "low.attempting");

    let releaseLock!: () => void;
    let reportAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => { reportAcquired = resolve; });
    const held = new Promise<void>((resolve) => { releaseLock = resolve; });
    const lockHolder = withFileLock(file, async () => {
      reportAcquired();
      await held;
    });
    await acquired;

    const high = startPresenceWriter([file, highReady, barrier, highAttempting, "1500"]);
    const low = startPresenceWriter([file, lowReady, barrier, lowAttempting, "1000"]);
    const writers = [high, low];
    let completedWhileLocked: boolean;
    try {
      await Promise.all([waitForFile(highReady), waitForFile(lowReady)]);
      await writeFile(barrier, "go\n", { mode: 0o600 });
      await Promise.all([waitForFile(highAttempting), waitForFile(lowAttempting)]);
      completedWhileLocked = await Promise.race([
        Promise.race(writers.map((writer) => writer.completion)).then(() => true),
        delay(250).then(() => false)
      ]);
    } catch (cause) {
      for (const writer of writers) writer.kill();
      await Promise.allSettled(writers.map((writer) => writer.completion));
      throw cause;
    } finally {
      releaseLock();
      await lockHolder;
    }
    await Promise.all(writers.map((writer) => writer.completion));

    expect(completedWhileLocked).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ lastActivityMs: 1_500 });
  });

  it("preserves its observed and durable high-water across stale, invalid, and future values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-presence-high-water-"));
    const file = join(dir, "presence.json");
    let nowMs = 1_000;
    const tracker = createFileBackedActivityTracker({ debounceMs: 0, file, now: () => nowMs });
    await tracker.record(800);
    await tracker.record(700);
    await tracker.record(-1);
    await tracker.record(Number.NaN);
    await tracker.record(1_001);
    expect(tracker.lastActivityMs()).toBe(800);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ lastActivityMs: 800 });

    nowMs = 1_100;
    await writeFile(file, `${JSON.stringify({ lastActivityMs: 600 })}\n`, "utf8");
    expect(tracker.lastActivityMs()).toBe(800);
    await writeFile(file, `${JSON.stringify({ lastActivityMs: 1_101 })}\n`, "utf8");
    expect(tracker.lastActivityMs()).toBe(800);
  });

  it("creates its dedicated parent privately and replaces a permissive file as private", async () => {
    const outer = await mkdtemp(join(tmpdir(), "muse-presence-permissions-"));
    const dedicated = join(outer, "presence-state");
    const file = join(dedicated, "presence.json");
    if (process.platform !== "win32") await chmod(outer, 0o755);

    const tracker = createFileBackedActivityTracker({ debounceMs: 0, file, now: () => 1_000 });
    await tracker.record(800);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ lastActivityMs: 800 });

    if (process.platform !== "win32") {
      expect((await stat(dedicated)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(outer)).mode & 0o777).toBe(0o755);
      await chmod(file, 0o644);
    }

    await tracker.record(900);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ lastActivityMs: 900 });
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(outer)).mode & 0o777).toBe(0o755);
    }
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
