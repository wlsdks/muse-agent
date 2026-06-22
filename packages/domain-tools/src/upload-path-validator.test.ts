import { describe, expect, it } from "vitest";

import { createAllowlistPathValidator } from "./upload-path-validator.js";

describe("createAllowlistPathValidator — allowlist + symlink-escape guard", () => {
  it("allows a path inside a root and returns its real (canonical) path", async () => {
    const validate = createAllowlistPathValidator({ roots: ["/dl"], realpath: async (p) => p });
    const result = await validate("/dl/resume.pdf");
    expect(result).toEqual({ allowed: true, resolvedPath: "/dl/resume.pdf" });
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
      realpath: async (p) => (p === "/dl/link" ? "/etc/passwd" : p),
      roots: ["/dl"]
    });
    const result = await validate("/dl/link");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/link|outside/i);
  });

  it("expands a leading ~ to the home dir before the roots check", async () => {
    const validate = createAllowlistPathValidator({ home: "/home/u", realpath: async (p) => p, roots: ["/home/u/Downloads"] });
    const result = await validate("~/Downloads/cv.pdf");
    expect(result).toEqual({ allowed: true, resolvedPath: "/home/u/Downloads/cv.pdf" });
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
      realpath: async (p) => (p === "/dl/alias" ? "/dl/real.pdf" : p),
      roots: ["/dl"]
    });
    const result = await validate("/dl/alias");
    expect(result).toEqual({ allowed: true, resolvedPath: "/dl/real.pdf" });
  });
});
