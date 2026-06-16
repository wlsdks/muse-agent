import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor, ToolRegistry } from "@muse/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFsReadTools } from "./fs-read-tools.js";
import { createFsWriteTools, type FsWriteApprovalGate } from "./fs-write-tools.js";

/**
 * End-to-end through the REAL runtime execute path (ToolRegistry + ToolExecutor,
 * the same seam agent-core drives), not a direct tool.execute() call — proving
 * the fs tools compose: write → read → edit → grep → delete, asserting actual
 * disk state at each step (agent-testing.md: grade the terminal state).
 */
describe("fs tools through ToolExecutor (terminal-state)", () => {
  let root: string;
  const allow: FsWriteApprovalGate = () => ({ approved: true });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "muse-fs-exec-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  function executor(): ToolExecutor {
    const opts = { baseDir: root, roots: [root] };
    const registry = new ToolRegistry([...createFsReadTools(opts), ...createFsWriteTools({ ...opts, approvalGate: allow })]);
    return new ToolExecutor({ registry });
  }

  const call = (exec: ToolExecutor, name: string, args: Record<string, unknown>) =>
    exec.execute({ arguments: args, context: { runId: "it", userId: "u" }, id: `${name}-1`, name });

  it("drives write → read → edit → grep → delete to the right terminal disk state", async () => {
    const exec = executor();
    const file = join(root, "notes", "todo.md");

    const wrote = await call(exec, "file_write", { content: "buy milk\nbuy eggs\n", path: file });
    expect(wrote.status).toBe("completed");
    expect(await readFile(file, "utf8")).toBe("buy milk\nbuy eggs\n");

    const read = await call(exec, "file_read", { path: file });
    expect(read.status).toBe("completed");
    expect(read.output).toContain("buy milk");

    const edited = await call(exec, "file_edit", { new_string: "buy oat milk", old_string: "buy milk", path: file });
    expect(edited.status).toBe("completed");
    expect(await readFile(file, "utf8")).toBe("buy oat milk\nbuy eggs\n");

    const grep = await call(exec, "file_grep", { mode: "content", path: root, pattern: "oat" });
    expect(grep.status).toBe("completed");
    expect(grep.output).toContain("oat milk");

    const deleted = await call(exec, "file_delete", { path: file });
    expect(deleted.status).toBe("completed");
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("a denied write leaves nothing on disk (executor surfaces the gate refusal)", async () => {
    const opts = { baseDir: root, roots: [root] };
    const registry = new ToolRegistry(createFsWriteTools({ ...opts, approvalGate: () => ({ approved: false, reason: "no" }) }));
    const exec = new ToolExecutor({ registry });
    const file = join(root, "blocked.md");

    const wrote = await exec.execute({ arguments: { content: "x", path: file }, context: { runId: "it", userId: "u" }, id: "w", name: "file_write" });
    expect(wrote.output).toContain("written");
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("a sandbox-denied read fails closed through the executor", async () => {
    const exec = executor();
    const out = await call(exec, "file_read", { path: join(root, ".ssh", "id_rsa") });
    expect(out.output).toMatch(/refused|protected/u);
  });
});
