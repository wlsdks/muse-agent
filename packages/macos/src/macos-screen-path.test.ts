import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isSymlink, resolveScreenshotPath } from "./macos-screen-path.js";

describe("resolveScreenshotPath", () => {
  it("accepts a plain filename under an allowed root", () => {
    const result = resolveScreenshotPath(join(homedir(), "Desktop", "shot.png"));
    expect(result.ok).toBe(true);
  });

  it("rejects a parent outside the allowed roots", () => {
    const result = resolveScreenshotPath("/etc/shot.png");
    expect(result.ok).toBe(false);
  });

  it("rejects a DANGLING symlink at the target (realpath throws → must not read as 'no escape')", () => {
    // A dangling symlink (target missing) makes realpathSync throw, which tryRealpath
    // swallows into returning the path itself — so the realpath-only check would pass it.
    // The lstat-based symlink check must reject it regardless of target existence.
    const result = resolveScreenshotPath(
      join(homedir(), "Desktop", "shot.png"),
      (p) => p, // realpath returns input unchanged (simulating the dangling-symlink throw→catch)
      () => true // symlinkAt: the target IS a symlink
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/symlink/i);
    }
  });

  it("isSymlink detects a real dangling symlink and resolveScreenshotPath rejects it", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-screen-"));
    const link = join(dir, "shot.png");
    symlinkSync(join(dir, "does-not-exist"), link);
    try {
      expect(isSymlink(link)).toBe(true);
      // tmpdir is an allowed root, so the parent passes — only the symlink guard can stop it.
      const result = resolveScreenshotPath(link);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
