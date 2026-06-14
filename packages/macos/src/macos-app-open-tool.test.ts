import type { MacCommandResult } from "./macos-exec.js";
import { describe, expect, it } from "vitest";

import { createMacAppOpenTool } from "./macos-app-open-tool.js";

const ctx = { runId: "r", userId: "u1" };
const ok = (stdout: string): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });

describe("createMacAppOpenTool", () => {
  it("is a well-formed execute tool requiring target", () => {
    const tool = createMacAppOpenTool();
    expect(tool.definition.name).toBe("mac_app_open");
    expect(tool.definition.risk).toBe("execute");
    expect((tool.definition.inputSchema as { required: string[] }).required).toEqual(["target"]);
  });

  it("rejects an empty target without spawning open", async () => {
    let called = false;
    const tool = createMacAppOpenTool({ runner: async () => { called = true; return ok(""); } });
    expect(await tool.execute({ target: "  " }, ctx)).toMatchObject({ opened: false });
    expect(called).toBe(false);
  });

  it("opens a bare app name with -a", async () => {
    let argv: readonly string[] = [];
    const tool = createMacAppOpenTool({ runner: async (a) => { argv = a; return ok(""); } });
    await tool.execute({ target: "Safari" }, ctx);
    expect(argv).toEqual(["-a", "Safari"]);
  });

  it("opens a URL directly (no -a)", async () => {
    let argv: readonly string[] = [];
    const tool = createMacAppOpenTool({ runner: async (a) => { argv = a; return ok(""); } });
    await tool.execute({ target: "https://example.com" }, ctx);
    expect(argv).toEqual(["https://example.com"]);
  });

  it("opens a filesystem path directly (no -a) — not as a bare app name", async () => {
    let argv: readonly string[] = [];
    const tool = createMacAppOpenTool({ runner: async (a) => { argv = a; return ok(""); } });
    await tool.execute({ target: "~/report.pdf" }, ctx);
    expect(argv).toEqual(["~/report.pdf"]);
  });

  it("forces a specific app with -a when `app` is given", async () => {
    let argv: readonly string[] = [];
    const tool = createMacAppOpenTool({ runner: async (a) => { argv = a; return ok(""); } });
    await tool.execute({ target: "https://example.com", app: "Google Chrome" }, ctx);
    expect(argv).toEqual(["-a", "Google Chrome", "https://example.com"]);
  });
});
