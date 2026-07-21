/**
 * An invalid `status` used to be swallowed silently: `muse.tasks.list` mapped
 * anything outside its enum to "open" and returned open tasks, so a model that
 * asked for "pending" got a different filter's results and reported them as the
 * answer. A wrong answer presented as fact is worse than an error.
 *
 * The contract now distinguishes the two cases, per tool-calling.md rule 7
 * (repair deterministically, don't make the model re-reason):
 *   - status OMITTED  → default to "open", silently. That is the documented default.
 *   - status INVALID  → still answer with "open", but SAY the filter was changed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTasksMcpServer } from "../src/index.js";

const ctx = { runId: "r", userId: "u" };

describe("muse.tasks.list never silently answers a different question", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muse-tasks-status-"));
    file = join(dir, "tasks.json");
    // The store reads a `{ tasks: [...] }` envelope, not a bare array — a bare
    // array is treated as a corrupt store and quarantined.
    writeFileSync(file, JSON.stringify({
      tasks: [
        { createdAt: "2026-07-01T00:00:00.000Z", id: "task_1", status: "open", title: "Open one" },
        { createdAt: "2026-07-01T00:00:00.000Z", id: "task_2", status: "done", title: "Done one" }
      ]
    }));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  const listTool = () => {
    const tool = createTasksMcpServer({ file }).tools.find((entry) => entry.name === "list");
    if (!tool) throw new Error("muse.tasks list tool is missing");
    return tool;
  };

  it("discloses the repair when the status is outside the enum", async () => {
    const out = await listTool().execute({ status: "pending" }, ctx) as { note?: string; status?: string; shown?: number };
    expect(out.status).toBe("open");
    expect(out.shown).toBe(1);
    // The disclosure is the whole point: without it the model reports open
    // tasks as if they were the pending ones it asked for.
    expect(out.note).toContain("pending");
    expect(out.note).toContain("open");
    expect(out.note).toContain("done");
  });

  it("stays SILENT when the status is simply omitted — that default is the contract", async () => {
    const out = await listTool().execute({}, ctx) as { note?: string; status?: string };
    expect(out.status).toBe("open");
    expect(out.note).toBeUndefined();
  });

  it("stays silent for each valid enum value", async () => {
    for (const status of ["open", "done", "all"]) {
      const out = await listTool().execute({ status }, ctx) as { note?: string; status?: string };
      expect(out.status, status).toBe(status);
      expect(out.note, status).toBeUndefined();
    }
  });
});
