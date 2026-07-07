import { describe, expect, it } from "vitest";

import type { MacCommandResult } from "./macos-exec.js";
import {
  APPLE_REMINDERS_MIRROR_ENV,
  buildMirrorReminderScript,
  isAppleRemindersMirrorEnabled,
  mirrorReminderToApple,
  type MirrorableReminder
} from "./macos-reminders-mirror.js";

const ok = (stdout = ""): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });
const on = { [APPLE_REMINDERS_MIRROR_ENV]: "true" } as Record<string, string | undefined>;

// A due timestamp far in the future to keep the epoch stable across the test's lifetime.
const REMINDER: MirrorableReminder = { text: "call mom", dueAt: "2026-06-13T15:00:00.000Z" };

describe("isAppleRemindersMirrorEnabled — the opt-in gate", () => {
  it("is OFF when the env var is absent", () => {
    expect(isAppleRemindersMirrorEnabled({})).toBe(false);
  });
  it("is OFF for every falsy value", () => {
    for (const v of ["false", "0", "no", "off", "", "  ", "maybe"]) {
      expect(isAppleRemindersMirrorEnabled({ [APPLE_REMINDERS_MIRROR_ENV]: v })).toBe(false);
    }
  });
  it("is ON for every truthy value, case/space-insensitive", () => {
    for (const v of ["true", "1", "yes", "on", "TRUE", " On "]) {
      expect(isAppleRemindersMirrorEnabled({ [APPLE_REMINDERS_MIRROR_ENV]: v })).toBe(true);
    }
  });
});

describe("mirrorReminderToApple — consent pin (zero exec when off)", () => {
  it("makes ZERO osascript calls when the env var is absent", async () => {
    let called = 0;
    const exec = async (): Promise<MacCommandResult> => { called += 1; return ok(); };
    const result = await mirrorReminderToApple(REMINDER, { env: {}, exec });
    expect(called).toBe(0);
    expect(result).toEqual({ mirrored: false, skipped: true });
  });
  it("makes ZERO osascript calls when the env var is explicitly false", async () => {
    let called = 0;
    const exec = async (): Promise<MacCommandResult> => { called += 1; return ok(); };
    const result = await mirrorReminderToApple(REMINDER, { env: { [APPLE_REMINDERS_MIRROR_ENV]: "false" }, exec });
    expect(called).toBe(0);
    expect(result.skipped).toBe(true);
  });
});

describe("mirrorReminderToApple — opted-in create", () => {
  it("spawns one make-new-reminder script with the title, note, and remind-me date", async () => {
    const scripts: string[] = [];
    const exec = async (script: string): Promise<MacCommandResult> => { scripts.push(script); return ok(); };
    const result = await mirrorReminderToApple(REMINDER, { env: on, exec });
    expect(result.mirrored).toBe(true);
    expect(scripts).toHaveLength(1);
    const script = scripts[0]!;
    expect(script).toContain('tell application "Reminders"');
    expect(script).toContain("make new reminder with properties {");
    expect(script).toContain('name:"call mom"');
    expect(script).toContain('body:"from Muse"');
    expect(script).toContain("remind me date:dueDate");
    // Epoch of 2026-06-13T15:00:00Z → the integer handed to `date -r`.
    const epoch = Math.floor(Date.parse(REMINDER.dueAt!) / 1000);
    expect(script).toContain(`date -r ${epoch.toString()} '+%Y-%m-%d %H:%M:%S'`);
  });

  it("targets a named list when one is supplied", async () => {
    const scripts: string[] = [];
    const exec = async (script: string): Promise<MacCommandResult> => { scripts.push(script); return ok(); };
    await mirrorReminderToApple(REMINDER, { env: on, exec, list: "Personal" });
    expect(scripts[0]!).toContain('make new reminder in list "Personal" with properties');
  });
});

describe("buildMirrorReminderScript — AppleScript injection safety (the test that matters most)", () => {
  const hostilePayloads: ReadonlyArray<{ name: string; title: string }> = [
    { name: "quote-and-tell", title: '"; tell app "Finder" to delete every item; "' },
    { name: "backslash", title: 'a\\"; do shell script "rm -rf ~"; "' },
    { name: "newline-break", title: "line one\n  end tell\n  tell application \"Finder\" to empty trash\n" },
    { name: "carriage-return", title: "a\r end tell \r tell app \"System Events\"" },
    { name: "korean-emoji", title: '엄마한테 전화 📞 "; delete; "' }
  ];

  // The structural invariant (independent of what the escaper does): the
  // generated script's SHAPE is fixed regardless of the payload. A payload that
  // broke out of the string literal would add lines (via raw newlines) or a
  // stray quote that closes `name:"..."` early — both are caught below without
  // re-deriving the escaper's output, so an identity escaper turns these RED.
  for (const { name, title } of hostilePayloads) {
    it(`renders ${name} as an inert single string literal`, () => {
      const script = buildMirrorReminderScript({ text: title, dueAt: REMINDER.dueAt });
      const lines = script.split("\n");
      // With a due date the shape is exactly: [set dueDate…], [tell…],
      // [  make new reminder…], [end tell]. A raw newline in the payload would
      // add lines — flattening to spaces keeps it at 4.
      expect(lines).toHaveLength(4);
      expect(lines[1]).toBe('tell application "Reminders"');
      expect(lines[3]).toBe("end tell");
      const propsLine = lines[2]!;
      expect(propsLine).not.toContain("\r");
      // The `name:"..."` literal must be WELL-FORMED: a regex that consumes a
      // properly-escaped literal (`\.` or a non-quote/non-backslash char) must
      // match, AND the char right after the closing quote must be a legal
      // property separator. An unescaped quote (identity escaper) closes the
      // literal early, leaving the next char as payload text (`;`, `t`, …).
      const match = /name:"((?:\\.|[^"\\])*)"/u.exec(propsLine);
      expect(match).not.toBeNull();
      const afterClose = propsLine.charAt(match!.index + match![0].length);
      expect([",", "}"]).toContain(afterClose);
    });
  }

  it("a hostile Finder-delete payload stays quoted, never a live statement", async () => {
    const scripts: string[] = [];
    const exec = async (script: string): Promise<MacCommandResult> => { scripts.push(script); return ok(); };
    await mirrorReminderToApple(
      { text: '"; tell application "Finder" to delete every item of home; "', dueAt: REMINDER.dueAt },
      { env: on, exec }
    );
    const script = scripts[0]!;
    // "Finder" may appear INSIDE the escaped title, but never as a statement on
    // its own line, and never after an UNescaped quote+semicolon boundary.
    expect(script).not.toMatch(/\n\s*tell application "Finder"/u);
    expect(script).not.toMatch(/[^\\]"; tell/u);
  });
});

describe("mirrorReminderToApple — fail-soft", () => {
  it("returns a warning (never throws) when osascript exits non-zero", async () => {
    const exec = async (): Promise<MacCommandResult> => ({ exitCode: 1, stderr: "boom", stdout: "", timedOut: false });
    const result = await mirrorReminderToApple(REMINDER, { env: on, exec });
    expect(result.mirrored).toBe(false);
    expect(result.warning).toContain("Apple Reminders mirror failed");
    expect(result.warning).toContain("boom");
  });

  it("maps a -1743 permission error to an actionable warning", async () => {
    const exec = async (): Promise<MacCommandResult> => ({
      exitCode: 1,
      stderr: "execution error: Not authorised to send Apple events (-1743)",
      stdout: "",
      timedOut: false
    });
    const result = await mirrorReminderToApple(REMINDER, { env: on, exec });
    expect(result.warning).toContain("Automation permission denied");
  });

  it("returns a warning when the runner times out", async () => {
    const exec = async (): Promise<MacCommandResult> => ({ exitCode: null, stderr: "", stdout: "", timedOut: true });
    const result = await mirrorReminderToApple(REMINDER, { env: on, exec });
    expect(result.mirrored).toBe(false);
    expect(result.warning).toContain("timed out");
  });

  it("returns a warning when the runner throws (spawn failure)", async () => {
    const exec = async (): Promise<MacCommandResult> => { throw new Error("ENOENT osascript"); };
    const result = await mirrorReminderToApple(REMINDER, { env: on, exec });
    expect(result.mirrored).toBe(false);
    expect(result.warning).toContain("ENOENT osascript");
  });
});

describe("mirrorReminderToApple — due-date mapping", () => {
  it("omits the remind-me date when the reminder has no due date", async () => {
    const scripts: string[] = [];
    const exec = async (script: string): Promise<MacCommandResult> => { scripts.push(script); return ok(); };
    await mirrorReminderToApple({ text: "someday" }, { env: on, exec });
    expect(scripts[0]!).not.toContain("remind me date");
    expect(scripts[0]!).not.toContain("date -r");
  });

  it("omits the remind-me date when the due date is unparseable", async () => {
    const scripts: string[] = [];
    const exec = async (script: string): Promise<MacCommandResult> => { scripts.push(script); return ok(); };
    await mirrorReminderToApple({ text: "someday", dueAt: "not-a-date" }, { env: on, exec });
    expect(scripts[0]!).not.toContain("remind me date");
  });
});
