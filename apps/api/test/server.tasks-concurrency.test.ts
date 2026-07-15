import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTasks } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("POST /api/tasks concurrency", () => {
  it("preserves every concurrent create through the locked store mutation", async () => {
    const tasksFile = join(mkdtempSync(join(tmpdir(), "muse-tasks-concurrent-")), "tasks.json");
    const server = buildServer({ logger: false, tasksFile });
    const responses = await Promise.all(Array.from({ length: 20 }, (_unused, index) =>
      server.inject({ method: "POST", url: "/api/tasks", payload: { title: `task ${index.toString()}` } })
    ));
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    expect(await readTasks(tasksFile)).toHaveLength(20);
  });
});
