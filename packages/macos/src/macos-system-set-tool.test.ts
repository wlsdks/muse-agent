import type { MacCommandResult } from "./macos-exec.js";
import { describe, expect, it } from "vitest";

import { createMacSystemSetTool } from "./macos-system-set-tool.js";

const ctx = { runId: "r", userId: "u1" };
const ok = (stdout: string): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });

describe("createMacSystemSetTool", () => {
  it("is a well-formed execute tool with a setting enum", () => {
    const tool = createMacSystemSetTool();
    expect(tool.definition.name).toBe("mac_system_set");
    expect(tool.definition.risk).toBe("execute");
    expect((tool.definition.inputSchema as { required: string[] }).required).toEqual(["setting"]);
  });

  it("sets the output volume, clamping into 0–100", async () => {
    let script = "";
    const tool = createMacSystemSetTool({ osascript: async (s) => { script = s; return ok(""); } });
    expect(await tool.execute({ setting: "volume", value: 30 }, ctx)).toEqual({ set: true, setting: "volume", value: 30 });
    expect(script).toBe("set volume output volume 30");
    const clamped = createMacSystemSetTool({ osascript: async () => ok("") });
    expect(await clamped.execute({ setting: "volume", value: 250 }, ctx)).toMatchObject({ value: 100 });
  });

  it("requires a numeric value for volume WITHOUT spawning osascript", async () => {
    let called = false;
    const tool = createMacSystemSetTool({ osascript: async () => { called = true; return ok(""); } });
    expect(await tool.execute({ setting: "volume" }, ctx)).toMatchObject({ set: false });
    expect(called).toBe(false);
  });
});
