import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTasksMcpServer } from "../src/index.js";
import { readTasks } from "@muse/stores";

describe("muse.tasks add/update — fail-close secret-persistence guard", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-tasks-secret-guard-"));
    file = join(dir, "tasks.json");
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });
  const addTool = () => createTasksMcpServer({ file }).tools.find((t) => t.name === "add")!;
  const updateTool = () => createTasksMcpServer({ file }).tools.find((t) => t.name === "update")!;

  it("add: refuses a password-bearing note and performs NO write", async () => {
    const out = await addTool().execute({ title: "reset router", notes: "비밀번호는 hunter2" }) as {
      error?: string;
      blocked?: boolean;
      kinds?: readonly string[];
    };
    expect(out.blocked).toBe(true);
    expect(out.error).toContain("암호화");
    expect(out.kinds).toContain("credential-label");
    expect(await readTasks(file)).toEqual([]);
  });

  it("add: a normal task still writes (control — 우유 사기 할 일에 추가해줘)", async () => {
    const out = await addTool().execute({ title: "우유 사기" }) as { task?: { title: string } };
    expect(out.task?.title).toBe("우유 사기");
    const tasks = await readTasks(file);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("우유 사기");
  });

  it("update: refuses when the new notes carry a credential, task stays unchanged", async () => {
    const created = (await addTool().execute({ title: "router" }) as { task: { id: string } }).task;
    const before = await readTasks(file);
    const out = await updateTool().execute({ id: created.id, notes: "api key: sk-proj-abcdefghijklmnopqrstuvwxyz" }) as {
      error?: string;
      blocked?: boolean;
    };
    expect(out.blocked).toBe(true);
    expect(await readTasks(file)).toEqual(before);
  });

  it("update: an ordinary rename still works (no over-block regression)", async () => {
    const created = (await addTool().execute({ title: "router" }) as { task: { id: string } }).task;
    const out = await updateTool().execute({ id: created.id, title: "reset the router" }) as { task?: { title: string } };
    expect(out.task?.title).toBe("reset the router");
  });
});
