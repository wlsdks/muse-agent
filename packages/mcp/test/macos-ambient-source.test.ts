import { describe, expect, it } from "vitest";

import { createAmbientNoticeRunner, MacOsActiveWindowSource, parseActiveWindowSignal, parseAmbientNoticeRules, type ProactiveNoticeSink } from "@muse/proactivity";

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

describe("MacOsActiveWindowSource — opt-in clipboard capture", () => {
  it("does NOT read the clipboard unless opted in (privacy default)", async () => {
    let clipboardRead = false;
    const source = new MacOsActiveWindowSource({
      readClipboard: async () => { clipboardRead = true; return "secret"; },
      run: async () => "Slack\n#general"
    });
    expect(await source.snapshot()).toEqual({ app: "Slack", window: "#general" });
    expect(clipboardRead).toBe(false);
  });

  it("with includeClipboard, attaches the (trimmed, capped) clipboard to the signal", async () => {
    const source = new MacOsActiveWindowSource({
      includeClipboard: true,
      maxClipboardChars: 8,
      readClipboard: async () => "  TRK-123456789  ",
      run: async () => "Mail\nInbox"
    });
    expect(await source.snapshot()).toEqual({ app: "Mail", clipboard: "TRK-1234", window: "Inbox" });
  });

  it("clipboard alone forms a signal when there is no frontmost app", async () => {
    const source = new MacOsActiveWindowSource({
      includeClipboard: true,
      readClipboard: async () => "https://track.example/x",
      run: async () => ""
    });
    expect(await source.snapshot()).toEqual({ clipboard: "https://track.example/x" });
  });

  it("a failing clipboard read is fail-soft — the window signal still returns", async () => {
    const source = new MacOsActiveWindowSource({
      includeClipboard: true,
      readClipboard: async () => { throw new Error("pbpaste missing"); },
      run: async () => "Slack\n#general"
    });
    expect(await source.snapshot()).toEqual({ app: "Slack", window: "#general" });
  });

  it("an empty clipboard adds nothing", async () => {
    const source = new MacOsActiveWindowSource({
      includeClipboard: true,
      readClipboard: async () => "   ",
      run: async () => "Slack\n#general"
    });
    expect(await source.snapshot()).toEqual({ app: "Slack", window: "#general" });
  });

  it("end-to-end: a copied tracking number drives a clipboard-keyed proactive notice", async () => {
    const source = new MacOsActiveWindowSource({
      includeClipboard: true,
      readClipboard: async () => "Your parcel TRK-99 is out for delivery",
      run: async () => "Mail\nInbox"
    });
    const rules = parseAmbientNoticeRules(JSON.stringify([
      { id: "parcel", match: { clipboard: "TRK-" }, message: "Want me to track that parcel?", title: "Parcel" }
    ]));
    const delivered: { title: string; text: string }[] = [];
    const sink: ProactiveNoticeSink = { deliver: (n) => { delivered.push(n); } };
    const runner = createAmbientNoticeRunner({ rules, sink, source });
    expect((await runner.tick()).delivered).toBe(1);
    expect(delivered[0]!.text).toContain("track that parcel");
  });
});
