import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isPathSafetyError, PathSafetyError, resolvePolicy, resolveSafePath } from "./fs-path-safety.js";

describe("path sandbox", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "muse-fs-root-"));
    outside = await mkdtemp(join(tmpdir(), "muse-fs-out-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  });

  const opts = () => ({ baseDir: root, roots: [root] });

  it("allows an ordinary file under the root and returns a canonical path", async () => {
    await writeFile(join(root, "todo.md"), "hi");
    const resolved = await resolveSafePath("todo.md", opts());
    expect(resolved.endsWith("todo.md")).toBe(true);
  });

  it("allows a not-yet-existing file under the root (write target)", async () => {
    const resolved = await resolveSafePath(join(root, "new", "draft.md"), opts());
    expect(resolved.endsWith(join("new", "draft.md"))).toBe(true);
  });

  it("refuses a path outside every root", async () => {
    await expect(resolveSafePath(join(outside, "x.txt"), opts())).rejects.toMatchObject({
      reason: "outside_roots"
    });
  });

  it("collapses traversal that escapes the root", async () => {
    await expect(resolveSafePath("../escape.txt", opts())).rejects.toBeInstanceOf(PathSafetyError);
  });

  it("refuses a symlink inside the root that points outside it", async () => {
    await writeFile(join(outside, "loot.txt"), "secret");
    await symlink(outside, join(root, "link"));
    await expect(resolveSafePath(join(root, "link", "loot.txt"), opts())).rejects.toMatchObject({
      reason: "outside_roots"
    });
  });

  it("refuses a denied directory segment even under the root (.ssh)", async () => {
    await mkdir(join(root, ".ssh"), { recursive: true });
    await writeFile(join(root, ".ssh", "id_ed25519"), "KEY");
    await expect(resolveSafePath(join(root, ".ssh", "id_ed25519"), opts())).rejects.toMatchObject({
      reason: "denied_path"
    });
  });

  it("refuses a project-local .muse state dir", async () => {
    await mkdir(join(root, ".muse"), { recursive: true });
    await expect(resolveSafePath(join(root, ".muse", "runs.jsonl"), opts())).rejects.toMatchObject({
      reason: "denied_path"
    });
  });

  it.each([".env", ".env.local", "service.pem", "api_secret.txt", "auth-token.json"])(
    "refuses secret-pattern basename %s",
    async (name) => {
      await writeFile(join(root, name), "x");
      await expect(resolveSafePath(name, opts())).rejects.toMatchObject({ reason: "denied_pattern" });
    }
  );

  it("allows an ordinary basename that merely contains a safe word", async () => {
    await writeFile(join(root, "environment-notes.md"), "x");
    await expect(resolveSafePath("environment-notes.md", opts())).resolves.toContain("environment-notes.md");
  });

  it("isPathSafetyError narrows correctly", async () => {
    try {
      await resolveSafePath(join(outside, "x"), opts());
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(isPathSafetyError(error)).toBe(true);
    }
  });

  it("resolvePolicy can be reused across calls", async () => {
    const policy = await resolvePolicy(opts());
    await writeFile(join(root, "a.txt"), "1");
    const resolved = await resolveSafePath("a.txt", opts(), policy);
    expect(resolved.endsWith("a.txt")).toBe(true);
  });
});
