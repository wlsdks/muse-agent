import type { MacCommandResult, MacOsascriptRunner } from "./macos-exec.js";
import { describe, expect, it } from "vitest";

import { createMacAppReadTool } from "./macos-app-read-tool.js";

const ctx = { runId: "r", userId: "u1" };
const ok = (stdout: string): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });

describe("createMacAppReadTool", () => {
  it("is a well-formed read tool with an app enum", () => {
    const tool = createMacAppReadTool();
    expect(tool.definition.name).toBe("mac_app_read");
    expect(tool.definition.risk).toBe("read");
    const schema = tool.definition.inputSchema as { required: string[]; properties: { app: { enum: string[] } } };
    expect(schema.required).toEqual(["app"]);
    expect(schema.properties.app.enum).toContain("music");
  });

  it("rejects an unknown app", async () => {
    const tool = createMacAppReadTool({ runner: async () => ok("") });
    expect(await tool.execute({ app: "browser" }, ctx)).toMatchObject({ error: expect.stringContaining("app must be one of") });
  });

  it("requires a query for contacts WITHOUT spawning osascript", async () => {
    let called = false;
    const runner: MacOsascriptRunner = async () => { called = true; return ok(""); };
    const tool = createMacAppReadTool({ runner });
    expect(await tool.execute({ app: "contacts" }, ctx)).toMatchObject({ error: expect.stringContaining("query") });
    expect(called).toBe(false);
  });

  it("reads the clipboard via the injected osascript runner", async () => {
    const tool = createMacAppReadTool({ runner: async () => ok("hello world\n") });
    expect(await tool.execute({ app: "clipboard" }, ctx)).toEqual({ app: "clipboard", text: "hello world" });
  });
});
