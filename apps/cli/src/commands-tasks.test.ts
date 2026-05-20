import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerTasksCommands, resolveLocalTaskId, type TasksCommandHelpers } from "./commands-tasks.js";

interface ApiCall {
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly method?: string;
}

async function runTasks(args: string[]): Promise<{
  readonly error?: string;
  readonly apiCalls: readonly ApiCall[];
}> {
  const apiCalls: ApiCall[] = [];
  const io = { stderr: () => {}, stdout: () => {} };
  const helpers: TasksCommandHelpers = {
    apiRequest: async (_io, _command, path, body, method) => {
      apiCalls.push({ body, method, path });
      return { id: "task_remote", status: "open", title: String(body?.title ?? "") };
    },
    writeOutput: () => {}
  };
  let error: string | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerTasksCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "tasks", "add", ...args]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return { apiCalls, error };
}

describe("muse tasks add — pre-dispatch --due validation", () => {
  it("remote mode rejects an invalid --due with the actionable error BEFORE any API call", async () => {
    const r = await runTasks(["ship", "the", "release", "--due", "blah-not-a-time"]);
    expect(r.error).toBeDefined();
    expect(r.error).toContain("ISO-8601");
    expect(r.error).toContain("relative phrase");
    expect(r.apiCalls).toHaveLength(0);
  });

  it("remote mode still sends a VALID --due raw to the API (server stays the resolution authority)", async () => {
    const r = await runTasks(["stand", "up", "--due", "in 3 hours"]);
    expect(r.error).toBeUndefined();
    expect(r.apiCalls).toHaveLength(1);
    expect(r.apiCalls[0]!.path).toBe("/api/tasks");
    expect(r.apiCalls[0]!.body).toMatchObject({ dueAt: "in 3 hours", title: "stand up" });
  });

  it("a task with no --due still posts (no spurious dueAt, no validation error)", async () => {
    const r = await runTasks(["just", "a", "title"]);
    expect(r.error).toBeUndefined();
    expect(r.apiCalls).toHaveLength(1);
    expect(r.apiCalls[0]!.body).toMatchObject({ title: "just a title" });
    expect(r.apiCalls[0]!.body?.dueAt).toBeUndefined();
  });

  it("local mode keeps rejecting an invalid --due with the same actionable error", async () => {
    const r = await runTasks(["--local", "do", "thing", "--due", "still-not-a-time"]);
    expect(r.error).toBeDefined();
    expect(r.error).toContain("relative phrase");
    expect(r.apiCalls).toHaveLength(0);
  });
});

describe("resolveLocalTaskId — typo-tolerant id resolution", () => {
  const tasks = [
    { createdAt: "2026-05-19T10:00:00.000Z", id: "task_abc123def", status: "open" as const, title: "alpha" },
    { createdAt: "2026-05-19T11:00:00.000Z", id: "task_xyz789ghi", status: "open" as const, title: "beta" }
  ];

  it("returns the exact id when found", () => {
    expect(resolveLocalTaskId("task_abc123def", tasks)).toBe("task_abc123def");
  });

  it("resolves an unambiguous prefix to the full id", () => {
    expect(resolveLocalTaskId("task_abc", tasks)).toBe("task_abc123def");
  });

  it("rejects an ambiguous prefix with the count + guidance", () => {
    expect(() => resolveLocalTaskId("task_", tasks)).toThrow(/ambiguous task prefix 'task_' matched 2 tasks/u);
  });

  it("suggests the closest existing id on a near-miss typo (one-char swap on the trailing char)", () => {
    expect(() => resolveLocalTaskId("task_abc123dex", tasks))
      .toThrow(/task not found: task_abc123dex — did you mean 'task_abc123def'/u);
  });

  it("rejects an unrelated input WITHOUT a guess (no random suggestion noise)", () => {
    expect(() => resolveLocalTaskId("totallyunrelated", tasks))
      .toThrow(/task not found: totallyunrelated$/u);
  });
});
