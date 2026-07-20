import type { MacCommandResult, MacOsascriptRunner } from "./macos-exec.js";
import { describe, expect, it } from "vitest";

import { createMacAppReadTool } from "./macos-app-read-tool.js";

const ctx = { runId: "r", userId: "u1" };
const ok = (stdout: string): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });

/**
 * Every read that targets a GUI app must ask `is running` FIRST.
 *
 * Without the guard, AppleScript LAUNCHES the app to answer the query: measured
 * at 4,395 ms with Reminders.app appearing on the user's screen, versus 59 ms
 * and no launch once guarded. A background read must never put a window in
 * front of the user, so this is asserted per-app rather than spot-checked.
 */
describe("mac_app_read — a background read never wakes a dormant GUI app", () => {
  const GUI_APP_READS = ["contacts", "mail_unread", "reminders", "calendar", "notes", "music", "safari_tab", "chrome_tab"] as const;

  for (const app of GUI_APP_READS) {
    it(`${app} checks 'is running' before touching the app`, async () => {
      let script = "";
      const runner: MacOsascriptRunner = async (s) => { script = s; return ok("not running"); };
      const tool = createMacAppReadTool({ runner });
      await tool.execute({ app, ...(app === "contacts" ? { query: "Jane" } : {}) }, ctx);

      expect(script, `${app} builds an AppleScript`).toContain("tell application");
      expect(script, `${app} must guard on 'is running'`).toMatch(/is (not )?running/u);
      // The guard has to come BEFORE the first real query, or the app is
      // already awake by the time it runs.
      const guardAt = script.search(/is (not )?running/u);
      const firstQueryAt = script.search(/\b(repeat with|unread count|every calendar|every note)/u);
      if (firstQueryAt >= 0) {
        expect(guardAt, `${app}: guard must precede the first query`).toBeLessThan(firstQueryAt);
      }
    });
  }
});

describe("createMacAppReadTool", () => {
  it("is a well-formed read tool with an app enum", () => {
    const tool = createMacAppReadTool();
    expect(tool.definition.name).toBe("mac_app_read");
    expect(tool.definition.risk).toBe("read");
    const schema = tool.definition.inputSchema as { required: string[]; properties: { app: { enum: string[] } } };
    expect(schema.required).toEqual(["app"]);
    expect(schema.properties.app.enum).toContain("music");
  });

  it("describes contact lookup as an explicit current read, not a future-intent musing", () => {
    const description = createMacAppReadTool().definition.description;
    expect(description).toMatch(/^NO-TOOL CONTACT RULE:.*statements.*musings.*future intentions.*adding or contacting.*not reads.*call no tool.*explicitly asks.*current lookup.*existing named contact.*phone.*email/iu);
    expect(description).toMatch(/contacts.*look up a person by name/iu);
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
