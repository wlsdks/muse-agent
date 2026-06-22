import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTasksMcpServer } from "../src/index.js";
import { writeTasks, type PersistedTask } from "@muse/mcp";

const TASKS: PersistedTask[] = [
  { createdAt: "2026-05-01T00:00:00", id: "t1", notes: "Q3 numbers", status: "open", tags: ["work"], title: "ship report" }, // "work" ONLY in the tag
  { createdAt: "2026-05-02T00:00:00", id: "t2", status: "open", tags: ["home"], title: "buy milk" },
  { createdAt: "2026-05-03T00:00:00", id: "t3", status: "open", title: "work on the deck" } // "work" in the title
];

describe("muse.tasks search — matches tags too (completes the tag-retrieval story)", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-search-tag-"));
    file = join(dir, "tasks.json");
    await writeTasks(file, TASKS);
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });
  const search = () => createTasksMcpServer({ file }).tools.find((t) => t.name === "search")!;

  it("finds a task by its TAG even when the query is in neither title nor notes (value flows)", async () => {
    const out = await search().execute({ query: "work" }) as { total: number; tasks: Array<{ id: string }> };
    const ids = out.tasks.map((t) => t.id);
    expect(ids).toContain("t1"); // tag-only "work" — the new behavior
    expect(ids).toContain("t3"); // "work" in the title — still matched
    expect(ids).not.toContain("t2"); // home-tagged, no "work" anywhere
  });

  it("tag match is case-insensitive substring (a 'work' query hits a 'Work' tag)", async () => {
    await writeTasks(file, [{ createdAt: "2026-05-01T00:00:00", id: "x", status: "open", tags: ["Work"], title: "nap" }]);
    const out = await search().execute({ query: "work" }) as { total: number };
    expect(out.total).toBe(1);
  });
});
