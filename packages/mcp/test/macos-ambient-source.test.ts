import { describe, expect, it } from "vitest";

import {
  createAmbientNoticeRunner,
  MacOsActiveWindowSource,
  parseActiveWindowSignal,
  parseAmbientNoticeRules,
  type ProactiveNoticeSink
} from "../src/index.js";

describe("parseActiveWindowSignal — osascript output → AmbientSignal", () => {
  it("reads app (line 1) + window title (line 2)", () => {
    expect(parseActiveWindowSignal("Calendar\nTeam Standup — 14:00")).toEqual({ app: "Calendar", window: "Team Standup — 14:00" });
  });

  it("an app with no front window yields just the app", () => {
    expect(parseActiveWindowSignal("Finder\n")).toEqual({ app: "Finder" });
  });

  it("empty output (no frontmost app / no permission) → undefined (loop stays quiet)", () => {
    expect(parseActiveWindowSignal("")).toBeUndefined();
    expect(parseActiveWindowSignal("\n")).toBeUndefined();
    expect(parseActiveWindowSignal(undefined)).toBeUndefined();
  });
});

describe("MacOsActiveWindowSource — snapshot over an injected osascript runner", () => {
  it("returns the parsed live signal", async () => {
    const source = new MacOsActiveWindowSource({ run: async () => "Slack\n#general" });
    expect(await source.snapshot()).toEqual({ app: "Slack", window: "#general" });
  });

  it("a failing or throwing osascript run yields undefined, never throws", async () => {
    const thrower = new MacOsActiveWindowSource({ run: async () => { throw new Error("not authorized for Accessibility"); } });
    expect(await thrower.snapshot()).toBeUndefined();
    const empty = new MacOsActiveWindowSource({ run: async () => undefined });
    expect(await empty.snapshot()).toBeUndefined();
  });

  it("end-to-end: the live active window drives a proactive notice through the runner", async () => {
    const source = new MacOsActiveWindowSource({ run: async () => "Calendar\nTeam Standup — 14:00" });
    const rules = parseAmbientNoticeRules(JSON.stringify([
      { id: "standup", match: { window: "standup" }, message: "Standup at 14:00 — open your notes.", title: "Standup" }
    ]));
    const delivered: { title: string; text: string }[] = [];
    const sink: ProactiveNoticeSink = { deliver: (n) => { delivered.push(n); } };
    const runner = createAmbientNoticeRunner({ rules, sink, source });

    expect((await runner.tick()).delivered).toBe(1); // standup window matched → fire
    expect((await runner.tick()).delivered).toBe(0); // same signal → edge-dedupe, no re-fire
    expect(delivered[0]!.text).toContain("Standup at 14:00");
  });
});
