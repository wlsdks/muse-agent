import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isPathSafetyError, PathSafetyError, pathSafetyOptionsFromEnv, resolvePolicy, resolveSafePath } from "./fs-path-safety.js";

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

  it("names the allowed roots in an outside_roots refusal so the model can self-correct", async () => {
    await expect(resolveSafePath(join(outside, "x.txt"), opts())).rejects.toMatchObject({
      message: expect.stringContaining(root),
      reason: "outside_roots"
    });
    // The actionable retry guidance must be present, not just the bare refusal.
    await expect(resolveSafePath(join(outside, "x.txt"), opts())).rejects.toMatchObject({
      message: expect.stringContaining("Retry with a path under one of these")
    });
  });

  it("does NOT enumerate allowed roots in a deny-list (secret) refusal — those stay opaque", async () => {
    await mkdir(join(root, ".ssh"), { recursive: true });
    await writeFile(join(root, ".ssh", "id_ed25519"), "KEY");
    await expect(resolveSafePath(join(root, ".ssh", "id_ed25519"), opts())).rejects.toMatchObject({
      message: expect.not.stringContaining("Allowed roots:"),
      reason: "denied_path"
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

  it.each(["secrets", "credentials", "app-credentials", "my_secret"])(
    "refuses a sensitive DIRECTORY component '%s' (audit #3), not just the basename",
    async (dir) => {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, "data.json"), "sk-REAL");
      await expect(resolveSafePath(join(root, dir, "data.json"), opts())).rejects.toMatchObject({
        reason: expect.stringMatching(/denied/u)
      });
    }
  );

  it("still ALLOWS an ordinary dir that merely contains a safe word (token-ring)", async () => {
    await mkdir(join(root, "token-ring"), { recursive: true });
    await writeFile(join(root, "token-ring", "readme.md"), "x");
    await expect(resolveSafePath(join(root, "token-ring", "readme.md"), opts())).resolves.toContain("token-ring");
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

  it.each([".npmrc", ".netrc", ".pgpass", ".pypirc", "client.p12", "keystore.pfx", "app.jks", "release.keystore"])(
    "refuses common credential / key-store file %s",
    async (name) => {
      await writeFile(join(root, name), "x");
      await expect(resolveSafePath(name, opts())).rejects.toMatchObject({ reason: "denied_pattern" });
    }
  );

  it.each(["notes.txt", "slides.key", "config.yaml", "package.json"])(
    "allows a NON-credential file %s (no over-block — .key is Keynote, not a key file here)",
    async (name) => {
      await writeFile(join(root, name), "x");
      await expect(resolveSafePath(name, opts())).resolves.toContain(name);
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

  it("denies a NOT-yet-existing path under a differently-cased protected dir", async () => {
    // No `.ssh` on disk, so realpath can't normalize the case — the deny must
    // still fire case-insensitively (macOS is case-insensitive).
    await expect(resolveSafePath(join(root, ".SSH", "newkey"), opts())).rejects.toMatchObject({
      reason: "denied_path"
    });
  });

  it("honours an extraDeny prefix", async () => {
    const secrets = join(root, "vault");
    await mkdir(secrets, { recursive: true });
    await writeFile(join(secrets, "note.md"), "x");
    await expect(
      resolveSafePath(join(secrets, "note.md"), { ...opts(), extraDeny: [secrets] })
    ).rejects.toMatchObject({ reason: "denied_path" });
  });

  it("a tighter root NARROWS the sandbox (a sibling under home is refused)", async () => {
    const notes = join(root, "notes");
    const other = join(root, "other");
    await mkdir(notes, { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "x.md"), "x");
    await expect(
      resolveSafePath(join(other, "x.md"), { baseDir: root, roots: [notes] })
    ).rejects.toMatchObject({ reason: "outside_roots" });
  });
});

describe("pathSafetyOptionsFromEnv", () => {
  it("parses MUSE_FS_ROOTS and MUSE_FS_DENY (':' or ',' separated)", () => {
    const out = pathSafetyOptionsFromEnv({ MUSE_FS_DENY: "/x/secrets", MUSE_FS_ROOTS: "/a:/b,/c" });
    expect(out.roots).toEqual(["/a", "/b", "/c"]);
    expect(out.extraDeny).toEqual(["/x/secrets"]);
  });

  it("returns no overrides when neither is set", () => {
    expect(pathSafetyOptionsFromEnv({})).toEqual({});
  });
});
