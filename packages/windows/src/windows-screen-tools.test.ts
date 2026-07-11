import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { createWinScreenshotTool } from "./windows-screen-tools.js";
import { defaultScreenshotPath, resolveWindowsScreenshotPath, tryRealpath } from "./windows-screen-path.js";
import type { WinCommandResult } from "./windows-exec.js";

const ok: WinCommandResult = { exitCode: 0, stderr: "", stdout: "", timedOut: false };

function capture(): { runner: (s: string) => Promise<WinCommandResult>; scripts: string[] } {
  const scripts: string[] = [];
  return { runner: async (s: string) => { scripts.push(s); return ok; }, scripts };
}

describe("resolveWindowsScreenshotPath", () => {
  it("defaults to an auto-named png under the temp dir", () => {
    const out = resolveWindowsScreenshotPath(undefined);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.resolved.startsWith(tryRealpath(tmpdir()) + sep)).toBe(true);
      expect(out.resolved.endsWith(".png")).toBe(true);
    }
  });

  it("accepts an explicit path under the temp dir; refuses one outside every root", () => {
    const inside = resolveWindowsScreenshotPath(join(tmpdir(), "shot.png"));
    expect(inside.ok).toBe(true);
    const outside = resolveWindowsScreenshotPath(join(sep, "etc", "shot.png"));
    expect(outside.ok).toBe(false);
  });

  it("refuses a non-png extension and a missing filename", () => {
    expect(resolveWindowsScreenshotPath(join(tmpdir(), "shot.jpg")).ok).toBe(false);
    expect(resolveWindowsScreenshotPath(tmpdir()).ok).toBe(false);
  });

  it("refuses a symlink at the target (write-redirect defense)", () => {
    const out = resolveWindowsScreenshotPath(join(tmpdir(), "link.png"), (p) => p, () => true);
    expect(out.ok).toBe(false);
  });

  it("defaultScreenshotPath stamps a unique-ish name", () => {
    const p = defaultScreenshotPath(new Date("2026-07-12T01:02:03.004Z"));
    expect(p).toContain("muse-screenshot-2026-07-12T01-02-03-004Z.png");
  });
});

describe("win_screenshot", () => {
  it("embeds the resolved path base64 into the CopyFromScreen script and saves PNG", async () => {
    const { runner, scripts } = capture();
    const path = join(tmpdir(), "muse-ci-shot.png");
    const out = await createWinScreenshotTool({ runner }).execute({ path }, { runId: "t" });
    expect(out).toMatchObject({ captured: true });
    expect(scripts[0]).toContain("CopyFromScreen");
    expect(scripts[0]).toContain("ImageFormat]::Png");
    expect(scripts[0]).toContain("FromBase64String");
  });

  it("refuses an out-of-roots path BEFORE spawning", async () => {
    const { runner, scripts } = capture();
    const out = await createWinScreenshotTool({ runner }).execute({ path: join(sep, "windows", "system32", "x.png") }, { runId: "t" });
    expect(out).toMatchObject({ captured: false });
    expect(scripts).toHaveLength(0);
  });

  it("fail-softs on a runner failure", async () => {
    const out = await createWinScreenshotTool({ runner: async () => ({ exitCode: 1, stderr: "GDI+ error", stdout: "", timedOut: false }) })
      .execute({}, { runId: "t" });
    expect(out).toMatchObject({ captured: false });
    expect((out as { reason: string }).reason).toContain("GDI+");
  });
});
