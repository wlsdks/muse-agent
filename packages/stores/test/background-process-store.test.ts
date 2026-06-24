import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getBackgroundProcess,
  pruneTerminalBackgroundProcesses,
  readBackgroundProcesses,
  registerBackgroundProcess,
  removeBackgroundProcess,
  updateBackgroundProcess,
  type BackgroundProcessRecord
} from "../src/index.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-bgp-")), "processes.json");
}

const rec = (over: Partial<BackgroundProcessRecord> = {}): BackgroundProcessRecord => ({
  id: "p1",
  pid: 4242,
  command: "npm run dev",
  startedAt: "2026-06-24T00:00:00.000Z",
  status: "running",
  ...over
});

describe("background-process registry store (X-3)", () => {
  it("registers and reads back a record (persistence round-trip)", async () => {
    const file = tmpFile();
    await registerBackgroundProcess(file, rec());
    expect(await readBackgroundProcesses(file)).toEqual([rec()]);
  });

  it("re-register with the same id replaces (idempotent), not duplicates", async () => {
    const file = tmpFile();
    await registerBackgroundProcess(file, rec({ pid: 1 }));
    await registerBackgroundProcess(file, rec({ pid: 2 }));
    const all = await readBackgroundProcesses(file);
    expect(all).toHaveLength(1);
    expect(all[0]!.pid).toBe(2);
  });

  it("updates a record by id (e.g. mark exited) leaving others intact", async () => {
    const file = tmpFile();
    await registerBackgroundProcess(file, rec({ id: "a" }));
    await registerBackgroundProcess(file, rec({ id: "b" }));
    await updateBackgroundProcess(file, "a", { status: "exited", exitCode: 0, endedAt: "2026-06-24T01:00:00.000Z" });
    expect((await getBackgroundProcess(file, "a"))?.status).toBe("exited");
    expect((await getBackgroundProcess(file, "b"))?.status).toBe("running");
  });

  it("removes a record by id", async () => {
    const file = tmpFile();
    await registerBackgroundProcess(file, rec({ id: "a" }));
    await registerBackgroundProcess(file, rec({ id: "b" }));
    await removeBackgroundProcess(file, "a");
    expect((await readBackgroundProcesses(file)).map((p) => p.id)).toEqual(["b"]);
  });

  it("prune removes terminal records (returning them), keeps running", async () => {
    const file = tmpFile();
    await registerBackgroundProcess(file, rec({ id: "run", status: "running" }));
    await registerBackgroundProcess(file, rec({ id: "done", status: "exited", exitCode: 0 }));
    await registerBackgroundProcess(file, rec({ id: "bad", status: "failed", exitCode: 1 }));
    const removed = await pruneTerminalBackgroundProcesses(file);
    expect(removed.map((r) => r.id).sort()).toEqual(["bad", "done"]);
    expect((await readBackgroundProcesses(file)).map((r) => r.id)).toEqual(["run"]);
  });

  it("reads a missing or corrupt file as empty (never throws)", async () => {
    expect(await readBackgroundProcesses(tmpFile())).toEqual([]);
    const file = tmpFile();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{not json", "utf8");
    expect(await readBackgroundProcesses(file)).toEqual([]);
  });

  it("drops malformed entries but keeps valid ones", async () => {
    const file = tmpFile();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({ processes: [rec(), { id: "bad" }, { not: "a record" }] }), "utf8");
    expect(await readBackgroundProcesses(file)).toEqual([rec()]);
  });
});
