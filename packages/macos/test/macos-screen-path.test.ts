import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveScreenshotPath } from "../src/macos-screen-path.js";

describe("resolveScreenshotPath — screenshot output-path sandbox", () => {
  it("accepts a path under the system temp dir (a non-existent target realpaths to itself)", () => {
    const r = resolveScreenshotPath(join(tmpdir(), "muse-shot.png"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.endsWith("muse-shot.png")).toBe(true);
  });

  it("rejects a path whose parent is outside the allowed roots", () => {
    const r = resolveScreenshotPath("/etc/evil.png");
    expect(r.ok).toBe(false);
  });

  it("rejects a path with no filename", () => {
    const r = resolveScreenshotPath("..");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("filename");
  });

  it("rejects a target that realpaths THROUGH a symlink to outside the allowed roots", () => {
    const r = resolveScreenshotPath(join(tmpdir(), "shot.png"), () => "/etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("symlink");
  });
});
