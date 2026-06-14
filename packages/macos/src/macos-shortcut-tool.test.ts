import type { MacCommandResult } from "./macos-exec.js";
import { describe, expect, it } from "vitest";

import { createMacShortcutRunTool, type ShortcutsRunner } from "./macos-shortcut-tool.js";

const ctx = { runId: "r", userId: "u1" };
const ok = (stdout: string): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });

describe("createMacShortcutRunTool", () => {
  it("is a well-formed execute tool requiring name", () => {
    const tool = createMacShortcutRunTool();
    expect(tool.definition.name).toBe("mac_shortcut_run");
    expect(tool.definition.risk).toBe("execute");
    expect((tool.definition.inputSchema as { required: string[] }).required).toEqual(["name"]);
  });

  it("rejects an empty name without spawning shortcuts", async () => {
    let called = false;
    const runner: ShortcutsRunner = async () => { called = true; return ok(""); };
    const tool = createMacShortcutRunTool({ runner });
    expect(await tool.execute({ name: "  " }, ctx)).toMatchObject({ ran: false });
    expect(called).toBe(false);
  });

  it("runs a named shortcut, capturing output via --output-path -", async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const runner: ShortcutsRunner = async (args, input) => { calls.push({ args, input }); return ok("done\n"); };
    const tool = createMacShortcutRunTool({ runner });
    expect(await tool.execute({ name: "Morning Routine" }, ctx)).toEqual({ name: "Morning Routine", output: "done", ran: true });
    expect(calls[0]!.args).toEqual(["run", "Morning Routine", "--output-path", "-"]);
  });

  it("passes a text input through --input-path -", async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const runner: ShortcutsRunner = async (args, input) => { calls.push({ args, input }); return ok(""); };
    const tool = createMacShortcutRunTool({ runner });
    await tool.execute({ name: "Echo", input: "Cupertino" }, ctx);
    expect(calls[0]!.args).toContain("--input-path");
    expect(calls[0]!.input).toBe("Cupertino");
  });
});
