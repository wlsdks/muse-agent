import type { MacCommandResult } from "./macos-exec.js";
import { describe, expect, it } from "vitest";

import { createMacMediaControlTool } from "./macos-media-tool.js";

const ctx = { runId: "r", userId: "u1" };
const ok = (stdout: string): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });

describe("createMacMediaControlTool", () => {
  it("is a well-formed execute tool with the transport-action enum", () => {
    const tool = createMacMediaControlTool();
    expect(tool.definition.name).toBe("mac_media_control");
    expect(tool.definition.risk).toBe("execute");
    const schema = tool.definition.inputSchema as { properties: { action: { enum: string[] } } };
    expect(schema.properties.action.enum).toEqual(["play", "pause", "playpause", "next", "previous"]);
  });

  it("rejects an action outside the enum (controlled: false, no runner call)", async () => {
    let called = false;
    const tool = createMacMediaControlTool({ runner: async () => { called = true; return ok(""); } });
    expect(await tool.execute({ action: "rewind" }, ctx)).toMatchObject({ controlled: false });
    expect(called).toBe(false);
  });

  it("guards pause behind `if it is running` so it never spuriously launches Music", async () => {
    let script = "";
    const tool = createMacMediaControlTool({ runner: async (s) => { script = s; return ok("paused"); } });
    expect(await tool.execute({ action: "pause" }, ctx)).toEqual({ action: "pause", controlled: true, state: "paused" });
    expect(script).toContain("if it is running");
  });

  it("maps next to the AppleScript track verb", async () => {
    let script = "";
    const tool = createMacMediaControlTool({ runner: async (s) => { script = s; return ok("playing"); } });
    await tool.execute({ action: "next" }, ctx);
    expect(script).toContain("next track");
  });
});
