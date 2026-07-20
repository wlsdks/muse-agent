import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultOrchestrationHistoryFile, FileOrchestrationHistoryStore } from "./orchestration-history-file.js";

import type { OrchestrationHistoryEntry } from "@muse/multi-agent";

// The whole point of the file store: history must survive a process
// restart with dates (incl. conversation timestamps) revived as Dates —
// the detail route calls .toISOString() on them.

const dir = mkdtempSync(join(tmpdir(), "muse-orch-hist-"));
afterEach(() => rmSync(dir, { force: true, recursive: true }));

const entry = (runId: string): OrchestrationHistoryEntry => ({
  completedCount: 2,
  conversation: [{ content: "hi", sourceAgentId: "a", timestamp: new Date("2026-07-12T01:00:00Z") }],
  durationMs: 1200,
  failedCount: 0,
  finishedAt: new Date("2026-07-12T01:00:01.200Z"),
  mode: "sequential",
  runId,
  startedAt: new Date("2026-07-12T01:00:00Z"),
  status: "completed",
  workerCount: 2
});

describe("FileOrchestrationHistoryStore", () => {
  it("resolves its default from injected HOME", () => {
    expect(defaultOrchestrationHistoryFile({ HOME: "/tmp/injected-home" }))
      .toBe(join("/tmp/injected-home", ".muse", "orchestration-history.json"));
  });

  it("entries survive a restart with Dates revived (incl. conversation timestamps)", () => {
    const file = join(dir, "history.json");
    const first = new FileOrchestrationHistoryStore(file);
    first.record(entry("run-1"));

    const reborn = new FileOrchestrationHistoryStore(file);
    const loaded = reborn.getByRunId("run-1");
    expect(loaded?.status).toBe("completed");
    expect(loaded?.startedAt).toBeInstanceOf(Date);
    expect(loaded?.conversation?.[0]?.timestamp).toBeInstanceOf(Date);
    expect(loaded?.conversation?.[0]?.timestamp.toISOString()).toBe("2026-07-12T01:00:00.000Z");
    expect(reborn.summary().totalRuns).toBe(1);
  });

  it("a corrupt file starts fresh instead of crashing the server", () => {
    const file = join(dir, "corrupt.json");
    const good = new FileOrchestrationHistoryStore(file);
    good.record(entry("run-x"));
    writeFileSync(file, "{not json", "utf8");
    const reborn = new FileOrchestrationHistoryStore(file);
    expect(reborn.list()).toHaveLength(0);
  });

  it("skips structurally invalid persisted entries before they reach API consumers", () => {
    const file = join(dir, "invalid-entry.json");
    new FileOrchestrationHistoryStore(file).record(entry("seed"));
    writeFileSync(
      file,
      JSON.stringify({
        entries: [
          entry("valid-run"),
          { ...entry("invalid-run"), conversation: [{ content: "hi", sourceAgentId: "a", timestamp: "not-a-date" }] },
          { ...entry("invalid-metrics"), durationMs: "1200" }
        ]
      }),
      "utf8"
    );

    const reborn = new FileOrchestrationHistoryStore(file);
    expect(reborn.list().map((item) => item.runId)).toEqual(["valid-run"]);
  });

  it("clear() empties disk too", () => {
    const file = join(dir, "clear.json");
    const store = new FileOrchestrationHistoryStore(file);
    store.record(entry("run-2"));
    store.clear();
    expect(new FileOrchestrationHistoryStore(file).list()).toHaveLength(0);
  });
});
