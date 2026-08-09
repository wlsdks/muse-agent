import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createAllowlistPathValidator } from "./upload-path-validator.js";

const identity = {
  bytes: 42,
  changedAtMs: 4,
  device: 1,
  inode: 2,
  modifiedAtMs: 3,
  sha256: "a".repeat(64)
};
const inspectFile = async () => identity;

describe("createAllowlistPathValidator — allowlist + symlink-escape guard", () => {
  it("allows a path inside a root and returns its real (canonical) path", async () => {
    const validate = createAllowlistPathValidator({ inspectFile, roots: ["/dl"], realpath: async (p) => p });
    const result = await validate("/dl/resume.pdf");
    expect(result).toMatchObject({
      allowed: true,
      identity,
      resolvedPath: resolve("/dl/resume.pdf"),
      uploadPath: resolve("/dl/resume.pdf")
    });
  });

  it("refuses a path lexically OUTSIDE every root (no realpath needed)", async () => {
    const validate = createAllowlistPathValidator({ roots: ["/dl"], realpath: async (p) => p });
    const result = await validate("/home/u/.ssh/id_rsa");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/outside/i);
  });

  it("refuses a symlink that lexically sits inside a root but RESOLVES outside it (symlink escape)", async () => {
    // /dl/link → /etc/passwd: lexically under /dl, but realpath escapes the root.
    const validate = createAllowlistPathValidator({
      realpath: async (p) => (p === resolve("/dl/link") ? resolve("/etc/passwd") : p),
      roots: ["/dl"]
    });
    const result = await validate("/dl/link");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/link|outside/i);
  });

  it("expands a leading ~ to the home dir before the roots check", async () => {
    const validate = createAllowlistPathValidator({ home: resolve("/home/u"), inspectFile, realpath: async (p) => p, roots: [resolve("/home/u/Downloads")] });
    const result = await validate("~/Downloads/cv.pdf");
    expect(result).toMatchObject({
      allowed: true,
      identity,
      resolvedPath: resolve("/home/u/Downloads/cv.pdf"),
      uploadPath: resolve("/home/u/Downloads/cv.pdf")
    });
  });

  it("refuses an empty path", async () => {
    const validate = createAllowlistPathValidator({ roots: ["/dl"], realpath: async (p) => p });
    const result = await validate("   ");
    expect(result.allowed).toBe(false);
  });

  it("refuses (fail-closed) when realpath throws — a missing/broken target is never allowed", async () => {
    const validate = createAllowlistPathValidator({
      realpath: async () => { throw new Error("ENOENT"); },
      roots: ["/dl"]
    });
    const result = await validate("/dl/gone.pdf");
    expect(result.allowed).toBe(false);
  });

  it("resolvedPath is the REAL (post-symlink) path when a link stays inside the root", async () => {
    // /dl/alias → /dl/real.pdf: still inside the root, so allowed, and the
    // canonical path is what gets returned (so the upload reads the real file).
    const validate = createAllowlistPathValidator({
      inspectFile,
      realpath: async (p) => (p === resolve("/dl/alias") ? resolve("/dl/real.pdf") : p),
      roots: ["/dl"]
    });
    const result = await validate("/dl/alias");
    expect(result).toMatchObject({
      allowed: true,
      identity,
      resolvedPath: resolve("/dl/real.pdf"),
      uploadPath: resolve("/dl/real.pdf")
    });
  });

  it("hashes the real regular file and returns its exact filesystem identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-upload-validator-"));
    const path = join(root, "resume.pdf");
    const bytes = Buffer.from("exact-upload-bytes");
    writeFileSync(path, bytes);
    const source = statSync(path);
    const result = await createAllowlistPathValidator({ roots: [root] })(path);
    expect(result).toMatchObject({
      allowed: true,
      identity: {
        bytes: bytes.byteLength,
        changedAtMs: source.ctimeMs,
        device: source.dev,
        inode: source.ino,
        modifiedAtMs: source.mtimeMs,
        sha256: createHash("sha256").update(bytes).digest("hex")
      },
      resolvedPath: realpathSync(path)
    });
    if (result.allowed) {
      try {
        expect(result.uploadPath).not.toBe(result.resolvedPath);
        expect(readFileSync(result.uploadPath)).toEqual(bytes);
        const stagedMode = statSync(result.uploadPath).mode & 0o777;
        expect(stagedMode & 0o222).toBe(0);
        if (process.platform !== "win32") {
          expect(stagedMode).toBe(0o400);
        }
      } finally {
        await result.cleanup();
      }
      expect(existsSync(result.uploadPath)).toBe(false);
    }
  });
});
