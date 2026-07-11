import { describe, expect, it } from "vitest";

import { createWinAppReadTool, parseReadOutput, WIN_APP_READ_SOURCES } from "./windows-app-read-tool.js";
import type { WinCommandResult } from "./windows-exec.js";

const result = (stdout: string): WinCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });

describe("win_app_read", () => {
  it("declares the source enum", () => {
    const tool = createWinAppReadTool();
    const props = tool.definition.inputSchema.properties as Record<string, { enum?: readonly string[] }>;
    expect(props["source"]!.enum).toEqual([...WIN_APP_READ_SOURCES]);
    expect(tool.definition.risk).toBe("read");
  });

  it("battery parses percent + charging", async () => {
    const out = await createWinAppReadTool({ runner: async () => result("87\tTrue\n") })
      .execute({ source: "battery" }, { runId: "t" });
    expect(out).toMatchObject({ charging: true, ok: true, percent: 87, source: "battery" });
  });

  it("battery on a desktop (no battery) fail-softs", async () => {
    const out = await createWinAppReadTool({ runner: async () => result("") })
      .execute({ source: "battery" }, { runId: "t" });
    expect(out).toMatchObject({ ok: false, source: "battery" });
  });

  it("frontmost returns the window title line", async () => {
    const out = await createWinAppReadTool({ runner: async () => result("report.docx - Word\n") })
      .execute({ source: "frontmost" }, { runId: "t" });
    expect(out).toMatchObject({ ok: true, source: "frontmost", window: "report.docx - Word" });
  });

  it("wifi extracts the SSID", () => {
    expect(parseReadOutput("wifi", "    SSID                   : HomeNet-5G\n")).toMatchObject({ ok: true, ssid: "HomeNet-5G" });
    expect(parseReadOutput("wifi", "")).toMatchObject({ ok: false });
  });

  it("storage parses drive rows", () => {
    const out = parseReadOutput("storage", "C\t120.5\t476.9\nD\t800.1\t931.5\n") as unknown as { drives: readonly { name: string; freeGb: number }[] };
    expect(out.drives).toHaveLength(2);
    expect(out.drives[0]).toMatchObject({ freeGb: 120.5, name: "C" });
  });

  it("an unknown source is refused without spawning; a failed spawn is fail-soft", async () => {
    let called = 0;
    const tool = createWinAppReadTool({ runner: async () => { called += 1; return result(""); } });
    const bad = await tool.execute({ source: "registry" }, { runId: "t" });
    expect(bad).toMatchObject({ ok: false });
    expect(called).toBe(0);
    const failing = createWinAppReadTool({ runner: async () => { throw new Error("spawn ENOENT"); } });
    const out = await failing.execute({ source: "battery" }, { runId: "t" });
    expect(out).toMatchObject({ ok: false });
  });
});
