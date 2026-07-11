import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTasksRegistryMcpServer } from "../src/loopback-tasks-registry.js";
import { LocalFileTasksProvider, TasksProviderRegistry } from "../src/tasks-providers.js";
import { readTasks } from "@muse/stores";

describe("muse.tasks-multi add — fail-close secret-persistence guard", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-tasks-registry-secret-guard-"));
    file = join(dir, "tasks.json");
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const addTool = () => {
    const registry = new TasksProviderRegistry([new LocalFileTasksProvider({ file })]);
    return createTasksRegistryMcpServer({ registry }).tools.find((t) => t.name === "add")!;
  };

  it("add: refuses a password-bearing task and performs NO write", async () => {
    const out = await addTool().execute({ title: "reset router", notes: "비밀번호는 hunter2" }) as {
      error?: string;
      blocked?: boolean;
      kinds?: readonly string[];
    };
    expect(out.blocked).toBe(true);
    expect(out.error).toBeTruthy();
    expect(out.kinds).toContain("credential-label");
    expect(await readTasks(file)).toEqual([]);
  });

  it("add: refuses when the label and value are split across title and notes", async () => {
    const out = await addTool().execute({ title: "비밀번호", notes: "hunter2 저장" }) as { blocked?: boolean };
    expect(out.blocked).toBe(true);
    expect(await readTasks(file)).toEqual([]);
  });

  it("add: ordinary content still writes normally (no over-block regression)", async () => {
    const out = await addTool().execute({ title: "회의록: API 설계 논의함" }) as { task?: { title: string } };
    expect(out.task?.title).toBe("회의록: API 설계 논의함");
    const tasks = await readTasks(file);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("회의록: API 설계 논의함");
  });
});
