import type { MacCommandResult } from "./macos-exec.js";
import { describe, expect, it } from "vitest";

import { createMacSystemSetTool, isMissingShortcutError } from "./macos-system-set-tool.js";

const ctx = { runId: "r", userId: "u1" };
const ok = (stdout: string): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });
const fail = (stderr: string): MacCommandResult => ({ exitCode: 1, stderr, stdout: "", timedOut: false });
/** The REAL macOS `shortcuts run <missing>` error captured on this box (KO locale). */
const REAL_MISSING = "Error: 작업을 완료할 수 없습니다. 단축어를 찾을 수 없음";

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

  it("exposes focus_on / focus_off in the setting enum", () => {
    const tool = createMacSystemSetTool();
    const en = (tool.definition.inputSchema as { properties: { setting: { enum: string[] } } }).properties.setting.enum;
    expect(en).toContain("focus_on");
    expect(en).toContain("focus_off");
  });

  it("focus_on runs the default 'Muse Focus On' shortcut via the shortcuts runner", async () => {
    let argv: readonly string[] = [];
    const tool = createMacSystemSetTool({ shortcuts: async (a) => { argv = a; return ok(""); } });
    expect(await tool.execute({ setting: "focus_on" }, ctx)).toEqual({ set: true, setting: "focus_on", shortcut: "Muse Focus On" });
    expect(argv).toEqual(["run", "Muse Focus On", "--output-path", "-"]);
  });

  it("focus_off runs the default 'Muse Focus Off' shortcut", async () => {
    let argv: readonly string[] = [];
    const tool = createMacSystemSetTool({ shortcuts: async (a) => { argv = a; return ok(""); } });
    expect(await tool.execute({ setting: "focus_off" }, ctx)).toMatchObject({ set: true, shortcut: "Muse Focus Off" });
    expect(argv[1]).toBe("Muse Focus Off");
  });

  it("env-style overrides win over the default shortcut names", async () => {
    let name = "";
    const tool = createMacSystemSetTool({
      focusOffShortcut: "집중 끄기",
      focusOnShortcut: "집중 켜기",
      shortcuts: async (a) => { name = a[1] ?? ""; return ok(""); }
    });
    await tool.execute({ setting: "focus_on" }, ctx);
    expect(name).toBe("집중 켜기");
    await tool.execute({ setting: "focus_off" }, ctx);
    expect(name).toBe("집중 끄기");
  });

  it("a missing Focus shortcut (REAL error) returns the actionable setup message", async () => {
    const tool = createMacSystemSetTool({ shortcuts: async () => fail(REAL_MISSING) });
    const result = await tool.execute({ setting: "focus_on" }, ctx) as { set: boolean; reason: string };
    expect(result.set).toBe(false);
    expect(result.reason).toContain("Muse Focus On");
    expect(result.reason).toContain("Set Focus");
    expect(result.reason).toContain("Shortcuts.app");
  });

  it("exposes bluetooth_on / bluetooth_off in the setting enum", () => {
    const tool = createMacSystemSetTool();
    const en = (tool.definition.inputSchema as { properties: { setting: { enum: string[] } } }).properties.setting.enum;
    expect(en).toContain("bluetooth_on");
    expect(en).toContain("bluetooth_off");
  });

  it("bluetooth_on runs the default 'Muse Bluetooth On' shortcut via the shortcuts runner", async () => {
    let argv: readonly string[] = [];
    const tool = createMacSystemSetTool({ shortcuts: async (a) => { argv = a; return ok(""); } });
    expect(await tool.execute({ setting: "bluetooth_on" }, ctx)).toEqual({ set: true, setting: "bluetooth_on", shortcut: "Muse Bluetooth On" });
    expect(argv).toEqual(["run", "Muse Bluetooth On", "--output-path", "-"]);
  });

  it("bluetooth_off + deps override runs the overridden shortcut name", async () => {
    let argv: readonly string[] = [];
    const tool = createMacSystemSetTool({ bluetoothOffShortcut: "My BT Off", shortcuts: async (a) => { argv = a; return ok(""); } });
    expect(await tool.execute({ setting: "bluetooth_off" }, ctx)).toEqual({ set: true, setting: "bluetooth_off", shortcut: "My BT Off" });
    expect(argv).toEqual(["run", "My BT Off", "--output-path", "-"]);
  });

  it("a missing Bluetooth shortcut (REAL error) returns the actionable setup message", async () => {
    const tool = createMacSystemSetTool({ shortcuts: async () => fail(REAL_MISSING) });
    const result = await tool.execute({ setting: "bluetooth_on" }, ctx) as { set: boolean; reason: string };
    expect(result.set).toBe(false);
    expect(result.reason).toContain("Muse Bluetooth On");
    expect(result.reason).toContain("Set Bluetooth");
    expect(result.reason).toContain("Shortcuts.app");
  });

  it("a NON-missing shortcuts failure surfaces the raw stderr, not the setup message", async () => {
    const tool = createMacSystemSetTool({ shortcuts: async () => fail("Error: some other failure") });
    const result = await tool.execute({ setting: "focus_off" }, ctx) as { set: boolean; reason: string };
    expect(result.set).toBe(false);
    expect(result.reason).toContain("some other failure");
    expect(result.reason).not.toContain("Set Focus");
  });

  it("fails soft when the shortcuts runner throws (no crash)", async () => {
    const tool = createMacSystemSetTool({ shortcuts: async () => { throw new Error("spawn ENOENT"); } });
    expect(await tool.execute({ setting: "focus_on" }, ctx)).toMatchObject({ reason: expect.stringContaining("spawn failed"), set: false });
  });

  it("fails soft when the shortcuts runner times out", async () => {
    const tool = createMacSystemSetTool({ shortcuts: async () => ({ exitCode: null, stderr: "", stdout: "", timedOut: true }) });
    expect(await tool.execute({ setting: "focus_on" }, ctx)).toMatchObject({ reason: expect.stringContaining("timed out"), set: false });
  });

  it("rejects an unknown setting", async () => {
    const tool = createMacSystemSetTool();
    expect(await tool.execute({ setting: "teleport" }, ctx)).toMatchObject({ set: false });
  });

  it("isMissingShortcutError matches both the KO and EN wording", () => {
    expect(isMissingShortcutError(REAL_MISSING)).toBe(true);
    expect(isMissingShortcutError("Error: The operation couldn't be completed. Shortcut not found")).toBe(true);
    expect(isMissingShortcutError("Error: permission denied")).toBe(false);
  });
});
