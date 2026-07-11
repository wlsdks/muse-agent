import { describe, expect, it } from "vitest";

import { createWinAppOpenTool } from "./windows-app-open-tool.js";
import type { WinCommandResult } from "./windows-exec.js";

const ok: WinCommandResult = { exitCode: 0, stderr: "", stdout: "", timedOut: false };

function capture(): { runner: (s: string) => Promise<WinCommandResult>; scripts: string[] } {
  const scripts: string[] = [];
  return { runner: async (s: string) => { scripts.push(s); return ok; }, scripts };
}

describe("win_app_open", () => {
  it("opens a URL via Start-Process with the target base64-embedded (never interpolated)", async () => {
    const { runner, scripts } = capture();
    const out = await createWinAppOpenTool({ runner }).execute({ target: "https://example.com/x?a=1&b='2'" }, { runId: "t" });
    expect(out).toMatchObject({ opened: true });
    expect(scripts[0]).toContain("Start-Process");
    expect(scripts[0]).toContain("FromBase64String");
    expect(scripts[0]).not.toContain("example.com");
  });

  it("forces the wrapping app when `app` is given", async () => {
    const { runner, scripts } = capture();
    const out = await createWinAppOpenTool({ runner }).execute({ app: "chrome", target: "https://example.com" }, { runId: "t" });
    expect(out).toMatchObject({ app: "chrome", opened: true });
    expect(scripts[0]).toContain("-ArgumentList");
  });

  it("refuses an empty target without spawning", async () => {
    const { runner, scripts } = capture();
    const out = await createWinAppOpenTool({ runner }).execute({ target: "  " }, { runId: "t" });
    expect(out).toMatchObject({ opened: false });
    expect(scripts).toHaveLength(0);
  });

  it("maps a non-zero exit to opened:false with the stderr tail", async () => {
    const out = await createWinAppOpenTool({
      runner: async () => ({ exitCode: 1, stderr: "The system cannot find the file zzz.", stdout: "", timedOut: false })
    }).execute({ target: "zzz" }, { runId: "t" });
    expect(out).toMatchObject({ opened: false });
    expect((out as { reason: string }).reason).toContain("cannot find");
  });

  it("maps a timeout and a spawn throw to fail-soft results", async () => {
    const timedOut = await createWinAppOpenTool({
      runner: async () => ({ exitCode: null, stderr: "", stdout: "", timedOut: true })
    }).execute({ target: "notepad" }, { runId: "t" });
    expect(timedOut).toMatchObject({ opened: false });
    const threw = await createWinAppOpenTool({
      runner: async () => { throw new Error("spawn powershell.exe ENOENT"); }
    }).execute({ target: "notepad" }, { runId: "t" });
    expect(threw).toMatchObject({ opened: false });
  });
});
