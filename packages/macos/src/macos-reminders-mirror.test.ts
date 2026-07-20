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
    let argsSeen: readonly string[] | undefined;
    const exec = async (script: string, args?: readonly string[]): Promise<MacCommandResult> => {
      scripts.push(script);
      argsSeen = args;
      return ok();
    };
    const result = await mirrorReminderToApple(REMINDER, { env: on, exec });
    expect(result.mirrored).toBe(true);
    expect(scripts).toHaveLength(1);
    const script = scripts[0]!;
    expect(script).toContain('tell application "Reminders"');
    expect(script).toContain("make new reminder with properties {");
    // Title/body travel as argv (osascript(1): "a list of strings to the direct
    // parameter of the run handler"), so the script references the bound names.
    expect(argsSeen).toEqual(["call mom", "from Muse", ""]);
    expect(script).toContain("name:reminderName");
    expect(script).toContain("body:reminderBody");
    expect(script).toContain("remind me date:dueDate");
    // Epoch of 2026-06-13T15:00:00Z → the integer handed to `date -r`.
    const epoch = Math.floor(Date.parse(REMINDER.dueAt!) / 1000);
    expect(script).toContain(`date -r ${epoch.toString()} '+%Y-%m-%d %H:%M:%S'`);
  });

  it("targets a named list when one is supplied", async () => {
    const scripts: string[] = [];
    let argsSeen: readonly string[] | undefined;
    const exec = async (script: string, args?: readonly string[]): Promise<MacCommandResult> => {
      scripts.push(script);
      argsSeen = args;
      return ok();
    };
    await mirrorReminderToApple(REMINDER, { env: on, exec, list: "Personal" });
    // The list NAME is argv data; only the structural choice (in-list vs not)
    // is baked into the script.
    expect(scripts[0]!).toContain("make new reminder in list targetList with properties");
    expect(argsSeen?.[2]).toBe("Personal");
    expect(scripts[0]!).not.toContain("Personal");
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

  // The invariant is now STRUCTURAL rather than about escaping quality: the
  // reminder text is passed to osascript as an argv item (Apple documents this
  // as "a list of strings to the direct parameter of the run handler",
  // osascript(1)), so it is never part of the script source. There is no
  // quoting to get wrong, and these assert exactly that — the payload appears
  // in `args` and nowhere in `script`.
  for (const { name, title } of hostilePayloads) {
    it(`passes ${name} as argv data that never enters the script source`, () => {
      const { args, script } = buildMirrorReminderScript({ text: title, dueAt: REMINDER.dueAt });

      expect(args[0]).toBe(title);
      expect(script).not.toContain(title);
      // Even a fragment that could start a statement must be absent.
      expect(script).not.toMatch(/tell app(lication)? "Finder"/u);
      expect(script).not.toContain("rm -rf");
      expect(script).not.toContain("empty trash");
      // The script shape is fixed and does not vary with the payload.
      expect(script).toContain("on run argv");
      expect(script).toContain("set reminderName to item 1 of argv");
    });
  }

  it("the script is byte-identical across wildly different payloads — data cannot change its shape", () => {
    const a = buildMirrorReminderScript({ text: "buy milk", dueAt: REMINDER.dueAt }).script;
    const b = buildMirrorReminderScript({ text: hostilePayloads[0]!.title, dueAt: REMINDER.dueAt }).script;
    expect(a).toBe(b);
  });

  it("a hostile Finder-delete payload reaches osascript as an argument, not a statement", async () => {
    const calls: Array<{ script: string; args: readonly string[] | undefined }> = [];
    const exec = async (script: string, args?: readonly string[]): Promise<MacCommandResult> => {
      calls.push({ args, script });
      return ok();
    };
    const hostile = '"; tell application "Finder" to delete every item of home; "';
    await mirrorReminderToApple({ text: hostile, dueAt: REMINDER.dueAt }, { env: on, exec });

    expect(calls[0]?.args?.[0]).toBe(hostile);
    expect(calls[0]?.script).not.toContain("Finder");
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
