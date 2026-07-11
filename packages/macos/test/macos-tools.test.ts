import { homedir } from "node:os";
import { join } from "node:path";

import { validateToolDefinitions } from "@muse/tools";
import { describe, expect, it } from "vitest";

import {
  createMacAppOpenTool,
  createMacAppReadTool,
  createMacClipboardSetTool,
  createMacMediaControlTool,
  createMacMessageSendTool,
  createMacSayTool,
  createMacScreenReadTool,
  createMacScreenshotTool,
  createMacShortcutRunTool,
  createMacSpotlightSearchTool,
  createMacSystemSetTool,
  type MacActionLogEntry,
  type MacCommandResult,
  type MacScreenReadToolDeps,
  type MacMessageSendToolDeps,
  type MacOsascriptRunner,
  type ShortcutsRunner
} from "../src/macos-tools.js";

const ctx = { runId: "r", userId: "u1" };
const ok = (stdout: string): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });
const fail = (stderr: string, exitCode = 1): MacCommandResult => ({ exitCode, stderr, stdout: "", timedOut: false });
const timedOut: MacCommandResult = { exitCode: null, stderr: "", stdout: "", timedOut: true };

describe("mac_shortcut_run — Tier 1 keystone", () => {
  it("is a well-formed execute tool (validateToolDefinitions-clean, Korean keyword, use-when/not-when)", () => {
    const tool = createMacShortcutRunTool();
    expect(tool.definition.name).toBe("mac_shortcut_run");
    expect(tool.definition.risk).toBe("execute");
    const schema = tool.definition.inputSchema as { required: string[]; additionalProperties: boolean };
    expect(schema.required).toEqual(["name"]);
    expect(schema.additionalProperties).toBe(false);
    expect(tool.definition.keywords).toContain("단축어");
    const d = tool.definition.description.toLowerCase();
    expect(d).toContain("use when");
    expect(d).toContain("do not");
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("rejects an empty name WITHOUT spawning shortcuts", async () => {
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
    const out = await tool.execute({ name: "Morning Routine" }, ctx);
    expect(out).toEqual({ name: "Morning Routine", output: "done", ran: true });
    expect(calls[0]!.args).toEqual(["run", "Morning Routine", "--output-path", "-"]);
    expect(calls[0]!.input).toBeUndefined();
  });

  it("pipes optional input via --input-path - (stdin)", async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const runner: ShortcutsRunner = async (args, input) => { calls.push({ args, input }); return ok(""); };
    const tool = createMacShortcutRunTool({ runner });
    await tool.execute({ input: "Cupertino", name: "Weather" }, ctx);
    expect(calls[0]!.args).toEqual(["run", "Weather", "--input-path", "-", "--output-path", "-"]);
    expect(calls[0]!.input).toBe("Cupertino");
  });

  it("maps an unknown-shortcut nonzero exit to ran:false with the stderr reason", async () => {
    const runner: ShortcutsRunner = async () => fail("The operation couldn't be completed. Shortcut not found.");
    const tool = createMacShortcutRunTool({ runner });
    expect(await tool.execute({ name: "Nope" }, ctx)).toMatchObject({ ran: false });
  });

  it("maps a watchdog timeout to ran:false", async () => {
    const runner: ShortcutsRunner = async () => timedOut;
    const tool = createMacShortcutRunTool({ runner });
    expect(await tool.execute({ name: "Slow" }, ctx)).toMatchObject({ ran: false });
  });
});

describe("mac_app_open — Tier 1 open app/URL/file", () => {
  it("is a well-formed execute tool requiring target", () => {
    const tool = createMacAppOpenTool();
    expect(tool.definition.name).toBe("mac_app_open");
    expect(tool.definition.risk).toBe("execute");
    const schema = tool.definition.inputSchema as { required: string[] };
    expect(schema.required).toEqual(["target"]);
    expect(tool.definition.keywords).toContain("열어");
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("rejects an empty target WITHOUT spawning open", async () => {
    let called = false;
    const tool = createMacAppOpenTool({ runner: async () => { called = true; return ok(""); } });
    expect(await tool.execute({ target: "  " }, ctx)).toMatchObject({ opened: false });
    expect(called).toBe(false);
  });

  it("opens a bare app name with -a", async () => {
    let argv: readonly string[] = [];
    const tool = createMacAppOpenTool({ runner: async (a) => { argv = a; return ok(""); } });
    expect(await tool.execute({ target: "Safari" }, ctx)).toEqual({ opened: true, target: "Safari" });
    expect(argv).toEqual(["-a", "Safari"]);
  });

  it("opens a URL directly (no -a)", async () => {
    let argv: readonly string[] = [];
    const tool = createMacAppOpenTool({ runner: async (a) => { argv = a; return ok(""); } });
    await tool.execute({ target: "https://example.com" }, ctx);
    expect(argv).toEqual(["https://example.com"]);
  });

  it("opens a file path directly (no -a)", async () => {
    let argv: readonly string[] = [];
    const tool = createMacAppOpenTool({ runner: async (a) => { argv = a; return ok(""); } });
    await tool.execute({ target: "/tmp/report.pdf" }, ctx);
    expect(argv).toEqual(["/tmp/report.pdf"]);
  });

  it("expands a leading ~/ before spawning open (spawn does no shell expansion)", async () => {
    let argv: readonly string[] = [];
    const tool = createMacAppOpenTool({ runner: async (a) => { argv = a; return ok(""); } });
    await tool.execute({ target: "~/report.pdf" }, ctx);
    expect(argv).toEqual([join(homedir(), "report.pdf")]);
  });

  it("forces a URL into a specific app via -a app target", async () => {
    let argv: readonly string[] = [];
    const tool = createMacAppOpenTool({ runner: async (a) => { argv = a; return ok(""); } });
    const out = await tool.execute({ app: "Google Chrome", target: "https://example.com" }, ctx);
    expect(out).toEqual({ app: "Google Chrome", opened: true, target: "https://example.com" });
    expect(argv).toEqual(["-a", "Google Chrome", "https://example.com"]);
  });

  it("maps a nonzero exit to opened:false", async () => {
    const tool = createMacAppOpenTool({ runner: async () => fail("Unable to find application named 'Nope'") });
    expect(await tool.execute({ target: "Nope" }, ctx)).toMatchObject({ opened: false });
  });
});

describe("mac_app_read — Tier 0 read", () => {
  it("is a well-formed read tool with an app enum", () => {
    const tool = createMacAppReadTool();
    expect(tool.definition.name).toBe("mac_app_read");
    expect(tool.definition.risk).toBe("read");
    const schema = tool.definition.inputSchema as { required: string[]; properties: { app: { enum: string[] } } };
    expect(schema.required).toEqual(["app"]);
    expect(schema.properties.app.enum).toContain("music");
    expect(validateToolDefinitions([tool])).toEqual([]);
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

  it("reads the clipboard", async () => {
    const tool = createMacAppReadTool({ runner: async () => ok("hello world\n") });
    expect(await tool.execute({ app: "clipboard" }, ctx)).toEqual({ app: "clipboard", text: "hello world" });
  });

  it("parses Music tab output into state/track/artist", async () => {
    const tool = createMacAppReadTool({ runner: async () => ok("playing\tNo Surprises\tRadiohead") });
    expect(await tool.execute({ app: "music" }, ctx)).toEqual({ app: "music", artist: "Radiohead", state: "playing", track: "No Surprises" });
  });

  it("parses the frontmost window", async () => {
    const tool = createMacAppReadTool({ runner: async () => ok("Safari\tApple — Start") });
    expect(await tool.execute({ app: "frontmost_window" }, ctx)).toEqual({ app: "frontmost_window", process: "Safari", windowTitle: "Apple — Start" });
  });

  it("parses contacts into a people array and passes the query into the script", async () => {
    let script = "";
    const runner: MacOsascriptRunner = async (s) => { script = s; return ok("Jane Doe\t+14155551212;\tjane@icloud.com;\n"); };
    const tool = createMacAppReadTool({ runner });
    const out = await tool.execute({ app: "contacts", query: "Jane" }, ctx);
    expect(out).toEqual({
      app: "contacts",
      people: [{ emails: ["jane@icloud.com"], name: "Jane Doe", phones: ["+14155551212"] }]
    });
    expect(script).toContain('name contains "Jane"');
  });

  it("parses mail_unread count + recent subjects", async () => {
    const tool = createMacAppReadTool({ runner: async () => ok("3\nHi\tStark\nLunch?\tJane\n") });
    expect(await tool.execute({ app: "mail_unread" }, ctx)).toEqual({
      app: "mail_unread",
      recent: [{ sender: "Stark", subject: "Hi" }, { sender: "Jane", subject: "Lunch?" }],
      unreadCount: 3
    });
  });

  it("maps an osascript -1743 permission failure to a Privacy & Security hint", async () => {
    const tool = createMacAppReadTool({ runner: async () => fail("execution error: Not authorized to send Apple events (-1743)") });
    expect(await tool.execute({ app: "music" }, ctx)).toMatchObject({ error: expect.stringContaining("Privacy & Security") });
  });

  it("parses a Safari front tab into url/title (and a closed browser into running:false)", async () => {
    const open = createMacAppReadTool({ runner: async () => ok("https://example.com\tExample Domain") });
    expect(await open.execute({ app: "safari_tab" }, ctx)).toEqual({ app: "safari_tab", running: true, title: "Example Domain", url: "https://example.com" });
    const closed = createMacAppReadTool({ runner: async () => ok("not running") });
    expect(await closed.execute({ app: "chrome_tab" }, ctx)).toEqual({ app: "chrome_tab", running: false });
  });

  it("parses volume settings into outputVolume + muted", async () => {
    const tool = createMacAppReadTool({ runner: async () => ok("45\tfalse") });
    expect(await tool.execute({ app: "volume" }, ctx)).toEqual({ app: "volume", muted: false, outputVolume: 45 });
  });

  it("reads battery via the shell runner (pmset, not osascript) and parses percent + charging", async () => {
    let osascriptCalled = false;
    let bin = "";
    let shellArgs: readonly string[] = [];
    const tool = createMacAppReadTool({
      runner: async () => { osascriptCalled = true; return ok(""); },
      shell: async (b, a) => { bin = b; shellArgs = a; return ok("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1) 95%; charged; 0:00 remaining present: true"); }
    });
    expect(await tool.execute({ app: "battery" }, ctx)).toEqual({ app: "battery", charging: true, percent: 95, state: "charged" });
    expect(bin).toContain("pmset");
    expect(shellArgs).toEqual(["-g", "batt"]);
    expect(osascriptCalled).toBe(false);
  });

  it("battery on battery power reports charging:false", async () => {
    const tool = createMacAppReadTool({ shell: async () => ok("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1) 62%; discharging; 3:12 remaining present: true") });
    expect(await tool.execute({ app: "battery" }, ctx)).toEqual({ app: "battery", charging: false, percent: 62, state: "discharging" });
  });

  it("reads storage via `df -h /` and parses the boot volume totals", async () => {
    let bin = "";
    let shellArgs: readonly string[] = [];
    const tool = createMacAppReadTool({
      shell: async (b, a) => { bin = b; shellArgs = a; return ok("Filesystem Size Used Avail Capacity iused ifree %iused Mounted on\n/dev/disk3s1s1 926Gi 12Gi 793Gi 2% 459k 4.3G 0% /"); }
    });
    expect(await tool.execute({ app: "storage" }, ctx)).toEqual({ app: "storage", available: "793Gi", capacity: "2%", total: "926Gi", used: "12Gi" });
    expect(bin).toContain("df");
    expect(shellArgs).toEqual(["-h", "/"]);
  });

  it("reads wifi_status (connected) via networksetup — parses device + network name, skips osascript", async () => {
    const LIST_PORTS = [
      "Hardware Port: Wi-Fi",
      "Device: en0",
      "Ethernet Address: aa:bb:cc:dd:ee:ff",
      ""
    ].join("\n");
    const GET_AIRPORT = "Current Wi-Fi Network: HomeNetwork";
    let osascriptCalled = false;
    const calls: Array<{ bin: string; args: readonly string[] }> = [];
    const tool = createMacAppReadTool({
      runner: async () => { osascriptCalled = true; return ok(""); },
      shell: async (b, a) => {
        calls.push({ bin: b, args: a });
        if (a[0] === "-listallhardwareports") return ok(LIST_PORTS);
        return ok(GET_AIRPORT);
      }
    });
    expect(await tool.execute({ app: "wifi_status" }, ctx)).toEqual({
      app: "wifi_status",
      connected: true,
      network: "HomeNetwork"
    });
    expect(osascriptCalled).toBe(false);
    expect(calls[0]?.args).toEqual(["-listallhardwareports"]);
    expect(calls[1]?.args).toEqual(["-getairportnetwork", "en0"]);
  });

  it("reads wifi_status (disconnected) when not associated with any network", async () => {
    const LIST_PORTS = "Hardware Port: Wi-Fi\nDevice: en1\nEthernet Address: 11:22:33:44:55:66\n";
    const GET_AIRPORT = "You are not associated with an Airport base station.";
    const tool = createMacAppReadTool({
      shell: async (_b, a) => a[0] === "-listallhardwareports" ? ok(LIST_PORTS) : ok(GET_AIRPORT)
    });
    expect(await tool.execute({ app: "wifi_status" }, ctx)).toEqual({
      app: "wifi_status",
      connected: false,
      network: null
    });
  });

  it("reads reminders via osascript and parses title + optional dueDate", async () => {
    let script = "";
    const runner: MacOsascriptRunner = async (s) => {
      script = s;
      return ok("Buy milk\t\nCall dentist\tThursday, June 13, 2026 at 9:00:00 AM\nReview PR\t\n");
    };
    const tool = createMacAppReadTool({ runner });
    const out = await tool.execute({ app: "reminders" }, ctx);
    expect(out).toEqual({
      app: "reminders",
      count: 3,
      items: [
        { title: "Buy milk" },
        { dueDate: "Thursday, June 13, 2026 at 9:00:00 AM", title: "Call dentist" },
        { title: "Review PR" }
      ]
    });
    expect(script).toContain("Reminders");
    expect(script).toContain("completed is false");
  });

  it("reminders: 'reminders' is in the tool enum", () => {
    const tool = createMacAppReadTool();
    const schema = tool.definition.inputSchema as { properties: { app: { enum: string[] } } };
    expect(schema.properties.app.enum).toContain("reminders");
  });

  it("reminders: description mentions 'reminders' and the not-when clause", () => {
    const tool = createMacAppReadTool();
    const d = tool.definition.description.toLowerCase();
    expect(d).toContain("reminders");
    expect(d).toContain("do not");
  });

  it("reminders: returns empty list with count 0 when no incomplete items exist", async () => {
    const tool = createMacAppReadTool({ runner: async () => ok("") });
    expect(await tool.execute({ app: "reminders" }, ctx)).toEqual({ app: "reminders", count: 0, items: [] });
  });

  it("reads calendar via osascript and parses title + start time", async () => {
    let script = "";
    const runner: MacOsascriptRunner = async (s) => {
      script = s;
      return ok("Team standup\tThursday, June 12, 2026 at 9:00:00 AM\nLunch with Alex\tThursday, June 12, 2026 at 12:30:00 PM\n");
    };
    const tool = createMacAppReadTool({ runner });
    const out = await tool.execute({ app: "calendar" }, ctx);
    expect(out).toEqual({
      app: "calendar",
      count: 2,
      items: [
        { start: "Thursday, June 12, 2026 at 9:00:00 AM", title: "Team standup" },
        { start: "Thursday, June 12, 2026 at 12:30:00 PM", title: "Lunch with Alex" }
      ]
    });
    expect(script).toContain("Calendar");
    expect(script).toContain("start date");
  });

  it("calendar: 'calendar' is in the tool enum", () => {
    const tool = createMacAppReadTool();
    const schema = tool.definition.inputSchema as { properties: { app: { enum: string[] } } };
    expect(schema.properties.app.enum).toContain("calendar");
  });

  it("calendar: description mentions 'calendar' and the not-when clause", () => {
    const tool = createMacAppReadTool();
    const d = tool.definition.description.toLowerCase();
    expect(d).toContain("calendar");
    expect(d).toContain("do not");
  });

  it("calendar: returns empty list with count 0 when no events today", async () => {
    const tool = createMacAppReadTool({ runner: async () => ok("") });
    expect(await tool.execute({ app: "calendar" }, ctx)).toEqual({ app: "calendar", count: 0, items: [] });
  });

  it("reads notes via osascript and parses note titles (up to 20)", async () => {
    let script = "";
    const runner: MacOsascriptRunner = async (s) => {
      script = s;
      return ok("Project ideas\nMeeting notes Q2\nRecipe: pasta\n");
    };
    const tool = createMacAppReadTool({ runner });
    const out = await tool.execute({ app: "notes" }, ctx);
    expect(out).toEqual({
      app: "notes",
      count: 3,
      items: [
        { title: "Project ideas" },
        { title: "Meeting notes Q2" },
        { title: "Recipe: pasta" }
      ]
    });
    expect(script).toContain("Notes");
    expect(script).toContain("name of n");
  });

  it("notes: 'notes' is in the tool enum", () => {
    const tool = createMacAppReadTool();
    const schema = tool.definition.inputSchema as { properties: { app: { enum: string[] } } };
    expect(schema.properties.app.enum).toContain("notes");
  });

  it("notes: description mentions 'notes' and the not-when clause", () => {
    const tool = createMacAppReadTool();
    const d = tool.definition.description.toLowerCase();
    expect(d).toContain("notes");
    expect(d).toContain("do not");
  });

  it("notes: returns empty list with count 0 when there are no notes", async () => {
    const tool = createMacAppReadTool({ runner: async () => ok("") });
    expect(await tool.execute({ app: "notes" }, ctx)).toEqual({ app: "notes", count: 0, items: [] });
  });

  it("reads ip_address via shell (ipconfig getifaddr <device>) and parses the IP", async () => {
    const LIST_PORTS = [
      "Hardware Port: Wi-Fi",
      "Device: en0",
      "Ethernet Address: aa:bb:cc:dd:ee:ff",
      ""
    ].join("\n");
    const IP_ADDR = "192.168.1.42\n";
    let osascriptCalled = false;
    const calls: Array<{ bin: string; args: readonly string[] }> = [];
    const tool = createMacAppReadTool({
      runner: async () => { osascriptCalled = true; return ok(""); },
      shell: async (b, a) => {
        calls.push({ bin: b, args: a });
        if (a[0] === "-listallhardwareports") return ok(LIST_PORTS);
        return ok(IP_ADDR);
      }
    });
    expect(await tool.execute({ app: "ip_address" }, ctx)).toEqual({ app: "ip_address", ip: "192.168.1.42" });
    expect(osascriptCalled).toBe(false);
    expect(calls[0]?.args).toEqual(["-listallhardwareports"]);
    expect(calls[1]?.args).toEqual(["getifaddr", "en0"]);
  });

  it("ip_address: returns ip:null when not connected (empty ipconfig output)", async () => {
    const LIST_PORTS = "Hardware Port: Wi-Fi\nDevice: en1\nEthernet Address: 11:22:33:44:55:66\n";
    const tool = createMacAppReadTool({
      shell: async (_b, a) => a[0] === "-listallhardwareports" ? ok(LIST_PORTS) : ok("")
    });
    expect(await tool.execute({ app: "ip_address" }, ctx)).toEqual({ app: "ip_address", ip: null });
  });

  it("ip_address: 'ip_address' is in the tool enum", () => {
    const tool = createMacAppReadTool();
    const schema = tool.definition.inputSchema as { properties: { app: { enum: string[] } } };
    expect(schema.properties.app.enum).toContain("ip_address");
  });

  it("ip_address: description mentions 'ip' and the not-when clause", () => {
    const tool = createMacAppReadTool();
    const d = tool.definition.description.toLowerCase();
    expect(d).toContain("ip");
    expect(d).toContain("do not");
  });

  it("reads running_apps via osascript (System Events) and parses app names", async () => {
    let script = "";
    const runner: MacOsascriptRunner = async (s) => {
      script = s;
      return ok("Safari, Finder, Terminal, Visual Studio Code\n");
    };
    const tool = createMacAppReadTool({ runner });
    const out = await tool.execute({ app: "running_apps" }, ctx);
    expect(out).toEqual({
      app: "running_apps",
      count: 4,
      apps: ["Safari", "Finder", "Terminal", "Visual Studio Code"]
    });
    expect(script).toContain("System Events");
    expect(script).toContain("background only is false");
  });

  it("running_apps: returns empty list with count 0 when no foreground apps", async () => {
    const tool = createMacAppReadTool({ runner: async () => ok("") });
    expect(await tool.execute({ app: "running_apps" }, ctx)).toEqual({ app: "running_apps", count: 0, apps: [] });
  });

  it("running_apps: parses newline-delimited output too", async () => {
    const tool = createMacAppReadTool({ runner: async () => ok("Safari\nFinder\nTerminal\n") });
    const out = await tool.execute({ app: "running_apps" }, ctx) as { apps: string[]; count: number };
    expect(out.apps).toContain("Safari");
    expect(out.apps).toContain("Finder");
    expect(out.count).toBe(3);
  });

  it("running_apps: 'running_apps' is in the tool enum", () => {
    const tool = createMacAppReadTool();
    const schema = tool.definition.inputSchema as { properties: { app: { enum: string[] } } };
    expect(schema.properties.app.enum).toContain("running_apps");
  });

  it("running_apps: description mentions 'running' apps and the not-when clause", () => {
    const tool = createMacAppReadTool();
    const d = tool.definition.description.toLowerCase();
    expect(d).toContain("running");
    expect(d).toContain("do not");
  });
});

describe("mac_media_control — Tier 1 Music transport", () => {
  it("is a well-formed execute tool with an action enum", () => {
    const tool = createMacMediaControlTool();
    expect(tool.definition.name).toBe("mac_media_control");
    expect(tool.definition.risk).toBe("execute");
    const schema = tool.definition.inputSchema as { required: string[]; properties: { action: { enum: string[] } } };
    expect(schema.required).toEqual(["action"]);
    expect(schema.properties.action.enum).toEqual(["play", "pause", "playpause", "next", "previous"]);
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("rejects an unknown action", async () => {
    const tool = createMacMediaControlTool({ runner: async () => ok("") });
    expect(await tool.execute({ action: "rewind" }, ctx)).toMatchObject({ controlled: false });
  });

  it("pause guards on `if it is running` (never spuriously launches Music)", async () => {
    let script = "";
    const tool = createMacMediaControlTool({ runner: async (s) => { script = s; return ok("paused"); } });
    const out = await tool.execute({ action: "pause" }, ctx);
    expect(out).toEqual({ action: "pause", controlled: true, state: "paused" });
    expect(script).toContain("if it is running");
    expect(script).toContain("pause");
  });

  it("play is allowed to launch Music (no running guard)", async () => {
    let script = "";
    const tool = createMacMediaControlTool({ runner: async (s) => { script = s; return ok("playing"); } });
    await tool.execute({ action: "play" }, ctx);
    expect(script).not.toContain("if it is running");
  });

  it("maps next/previous to the AppleScript track verbs", async () => {
    let script = "";
    const tool = createMacMediaControlTool({ runner: async (s) => { script = s; return ok("playing"); } });
    await tool.execute({ action: "next" }, ctx);
    expect(script).toContain("next track");
  });
});

describe("mac_system_set — Tier 1 volume / mute / display sleep", () => {
  it("is a well-formed execute tool with a setting enum", () => {
    const tool = createMacSystemSetTool();
    expect(tool.definition.name).toBe("mac_system_set");
    expect(tool.definition.risk).toBe("execute");
    const schema = tool.definition.inputSchema as { required: string[] };
    expect(schema.required).toEqual(["setting"]);
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("sets the output volume, clamping into 0–100", async () => {
    let script = "";
    const tool = createMacSystemSetTool({ osascript: async (s) => { script = s; return ok(""); } });
    expect(await tool.execute({ setting: "volume", value: 30 }, ctx)).toEqual({ set: true, setting: "volume", value: 30 });
    expect(script).toBe("set volume output volume 30");
    const tool2 = createMacSystemSetTool({ osascript: async () => ok("") });
    expect(await tool2.execute({ setting: "volume", value: 250 }, ctx)).toMatchObject({ value: 100 });
  });

  it("requires a numeric value for volume", async () => {
    let called = false;
    const tool = createMacSystemSetTool({ osascript: async () => { called = true; return ok(""); } });
    expect(await tool.execute({ setting: "volume" }, ctx)).toMatchObject({ set: false });
    expect(called).toBe(false);
  });

  it("mutes and unmutes via output muted", async () => {
    let script = "";
    const tool = createMacSystemSetTool({ osascript: async (s) => { script = s; return ok(""); } });
    await tool.execute({ setting: "mute" }, ctx);
    expect(script).toBe("set volume output muted true");
    await tool.execute({ setting: "unmute" }, ctx);
    expect(script).toBe("set volume output muted false");
  });

  it("sleeps the display via pmset (not osascript)", async () => {
    let pmsetArgs: readonly string[] = [];
    let osascriptCalled = false;
    const tool = createMacSystemSetTool({
      osascript: async () => { osascriptCalled = true; return ok(""); },
      pmset: async (a) => { pmsetArgs = a; return ok(""); }
    });
    expect(await tool.execute({ setting: "display_sleep" }, ctx)).toEqual({ set: true, setting: "display_sleep" });
    expect(pmsetArgs).toEqual(["displaysleepnow"]);
    expect(osascriptCalled).toBe(false);
  });

  it("sleeps the whole Mac via `pmset sleepnow`", async () => {
    let pmsetArgs: readonly string[] = [];
    const tool = createMacSystemSetTool({ pmset: async (a) => { pmsetArgs = a; return ok(""); } });
    expect(await tool.execute({ setting: "sleep" }, ctx)).toEqual({ set: true, setting: "sleep" });
    expect(pmsetArgs).toEqual(["sleepnow"]);
  });

  it("toggles Wi-Fi by detecting the interface then setting airport power", async () => {
    const calls: Array<readonly string[]> = [];
    const tool = createMacSystemSetTool({
      networksetup: async (a) => {
        calls.push(a);
        return a[0] === "-listallhardwareports"
          ? ok("Hardware Port: Ethernet\nDevice: en1\n\nHardware Port: Wi-Fi\nDevice: en0\n")
          : ok("");
      }
    });
    expect(await tool.execute({ setting: "wifi_off" }, ctx)).toEqual({ device: "en0", set: true, setting: "wifi_off" });
    expect(calls[0]).toEqual(["-listallhardwareports"]);
    expect(calls[1]).toEqual(["-setairportpower", "en0", "off"]);
    await tool.execute({ setting: "wifi_on" }, ctx);
    expect(calls[3]).toEqual(["-setairportpower", "en0", "on"]);
  });

  it("reports no Wi-Fi interface gracefully", async () => {
    const tool = createMacSystemSetTool({ networksetup: async () => ok("Hardware Port: Ethernet\nDevice: en1\n") });
    expect(await tool.execute({ setting: "wifi_on" }, ctx)).toMatchObject({ set: false });
  });
});

describe("mac_say — Tier 1 text-to-speech", () => {
  it("is a well-formed execute tool requiring text", () => {
    const tool = createMacSayTool();
    expect(tool.definition.name).toBe("mac_say");
    expect(tool.definition.risk).toBe("execute");
    expect((tool.definition.inputSchema as { required: string[] }).required).toEqual(["text"]);
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("rejects empty text WITHOUT spawning say", async () => {
    let called = false;
    const tool = createMacSayTool({ runner: async () => { called = true; return ok(""); } });
    expect(await tool.execute({ text: "  " }, ctx)).toMatchObject({ spoke: false });
    expect(called).toBe(false);
  });

  it("speaks the text (and passes -v voice when given)", async () => {
    let argv: readonly string[] = [];
    const tool = createMacSayTool({ runner: async (a) => { argv = a; return ok(""); } });
    expect(await tool.execute({ text: "Build done" }, ctx)).toEqual({ spoke: true });
    expect(argv).toEqual(["--", "Build done"]);
    await tool.execute({ text: "Hi", voice: "Samantha" }, ctx);
    expect(argv).toEqual(["-v", "Samantha", "--", "Hi"]);
  });

  it("inserts a '--' option terminator so leading-dash text is not reparsed as a say flag", async () => {
    // Without the terminator a text of "-0" / "--version" is consumed by `say` as an
    // option (say "-0" → exit 1 "invalid option"); `say` supports `--` (mdfind/pbcopy
    // do not, so this guard is say-specific). The user value must reach say as text.
    let argv: readonly string[] = [];
    const tool = createMacSayTool({ runner: async (a) => { argv = a; return ok(""); } });
    expect(await tool.execute({ text: "-0" }, ctx)).toEqual({ spoke: true });
    expect(argv).toEqual(["--", "-0"]);
    await tool.execute({ text: "--version", voice: "Samantha" }, ctx);
    expect(argv).toEqual(["-v", "Samantha", "--", "--version"]);
  });
});

describe("mac_screenshot — Tier 1 capture screen", () => {
  it("is a well-formed execute tool with no required args", () => {
    const tool = createMacScreenshotTool();
    expect(tool.definition.name).toBe("mac_screenshot");
    expect(tool.definition.risk).toBe("execute");
    expect((tool.definition.inputSchema as { required: string[] }).required).toEqual([]);
    expect(tool.definition.keywords).toContain("스크린샷");
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("captures to a default temp path (screencapture -x) and returns it", async () => {
    let captured = "";
    const tool = createMacScreenshotTool({ pathFactory: () => "/tmp/fixed.png", runner: async (p) => { captured = p; return ok(""); } });
    expect(await tool.execute({}, ctx)).toEqual({ captured: true, path: "/tmp/fixed.png" });
    expect(captured).toBe("/tmp/fixed.png");
  });

  it.skipIf(process.platform === "win32")("honors a caller-supplied path under ~/Desktop (expands ~ and passes resolved path to runner)", async () => {
    let captured = "";
    const tool = createMacScreenshotTool({ runner: async (p) => { captured = p; return ok(""); } });
    const result = await tool.execute({ path: "~/Desktop/shot.png" }, ctx);
    expect(result).toMatchObject({ captured: true });
    expect(captured).not.toBe("~/Desktop/shot.png");
    expect(captured).toMatch(/\/Desktop\/shot\.png$/);
  });

  it("refuses and does NOT call runner when path escapes to ~/.ssh/authorized_keys", async () => {
    let runnerCalled = false;
    const tool = createMacScreenshotTool({ runner: async () => { runnerCalled = true; return ok(""); } });
    const result = await tool.execute({ path: "/Users/x/.ssh/authorized_keys" }, ctx);
    expect(result).toMatchObject({ captured: false });
    expect(runnerCalled).toBe(false);
  });

  it("refuses a symlink-at-target whose real path escapes the allowlist (parent passes, target symlinks out)", async () => {
    // The harder vector: ~/Desktop (allowed parent) contains a pre-placed symlink
    // shot.png -> /etc/passwd. The parent check passes; only realpathing the FULL
    // target catches it. Inject a realpath that resolves the target outside.
    let runnerCalled = false;
    const tool = createMacScreenshotTool({
      runner: async () => { runnerCalled = true; return ok(""); },
      realpath: (p) => (p.endsWith("shot.png") ? "/etc/passwd" : p)
    });
    const result = await tool.execute({ path: "~/Desktop/shot.png" }, ctx);
    expect(result).toMatchObject({ captured: false });
    expect(runnerCalled).toBe(false);
  });

  it("refuses and does NOT call runner for a path containing traversal (../../etc/passwd)", async () => {
    let runnerCalled = false;
    const tool = createMacScreenshotTool({ runner: async () => { runnerCalled = true; return ok(""); } });
    const result = await tool.execute({ path: "/tmp/../../etc/passwd" }, ctx);
    expect(result).toMatchObject({ captured: false });
    expect(runnerCalled).toBe(false);
  });

  it("refuses and does NOT call runner for a path whose parent is outside the allowlist", async () => {
    let runnerCalled = false;
    const tool = createMacScreenshotTool({ runner: async () => { runnerCalled = true; return ok(""); } });
    const result = await tool.execute({ path: "/var/www/html/evil.png" }, ctx);
    expect(result).toMatchObject({ captured: false });
    expect(runnerCalled).toBe(false);
  });

  it.skipIf(process.platform === "win32")("allows a path under the system temp dir (resolves symlinks like /tmp → /private/tmp)", async () => {
    let captured = "";
    const tool = createMacScreenshotTool({ runner: async (p) => { captured = p; return ok(""); } });
    const result = await tool.execute({ path: "/tmp/muse-test.png" }, ctx);
    expect(result).toMatchObject({ captured: true });
    expect(captured).toMatch(/muse-test\.png$/);
  });

  it("maps a nonzero exit to captured:false", async () => {
    const tool = createMacScreenshotTool({ runner: async () => fail("could not create image") });
    expect(await tool.execute({}, ctx)).toMatchObject({ captured: false });
  });
});

describe("mac_clipboard_set — Tier 1 set clipboard", () => {
  it("is a well-formed execute tool requiring text", () => {
    const tool = createMacClipboardSetTool();
    expect(tool.definition.name).toBe("mac_clipboard_set");
    expect(tool.definition.risk).toBe("execute");
    expect((tool.definition.inputSchema as { required: string[] }).required).toEqual(["text"]);
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("rejects empty text WITHOUT spawning pbcopy", async () => {
    let called = false;
    const tool = createMacClipboardSetTool({ runner: async () => { called = true; return ok(""); } });
    expect(await tool.execute({ text: "" }, ctx)).toMatchObject({ set: false });
    expect(called).toBe(false);
  });

  it("pipes the text to pbcopy and reports the char count", async () => {
    let piped = "";
    const tool = createMacClipboardSetTool({ runner: async (t) => { piped = t; return ok(""); } });
    expect(await tool.execute({ text: "123 Main St" }, ctx)).toEqual({ chars: 11, set: true });
    expect(piped).toBe("123 Main St");
  });
});

describe("mac_spotlight_search — Tier 0 find files", () => {
  it("is a well-formed read tool requiring query", () => {
    const tool = createMacSpotlightSearchTool();
    expect(tool.definition.name).toBe("mac_spotlight_search");
    expect(tool.definition.risk).toBe("read");
    expect((tool.definition.inputSchema as { required: string[] }).required).toEqual(["query"]);
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("runs mdfind by content by default and caps + reports paths", async () => {
    let argv: readonly string[] = [];
    const tool = createMacSpotlightSearchTool({ runner: async (a) => { argv = a; return ok("/a/budget.xlsx\n/b/old budget.xlsx\n"); } });
    expect(await tool.execute({ query: "budget" }, ctx)).toEqual({ paths: ["/a/budget.xlsx", "/b/old budget.xlsx"], query: "budget", total: 2 });
    expect(argv).toEqual(["budget"]);
  });

  it("uses -name when nameOnly is true", async () => {
    let argv: readonly string[] = [];
    const tool = createMacSpotlightSearchTool({ runner: async (a) => { argv = a; return ok(""); } });
    await tool.execute({ nameOnly: true, query: "résumé.pdf" }, ctx);
    expect(argv).toEqual(["-name", "résumé.pdf"]);
  });

  it("flags truncation past the result cap", async () => {
    const many = Array.from({ length: 40 }, (_v, i) => `/f/${i.toString()}.txt`).join("\n");
    const tool = createMacSpotlightSearchTool({ runner: async () => ok(many) });
    const out = await tool.execute({ query: "x" }, ctx) as { paths: string[]; total: number; truncated?: boolean };
    expect(out.paths).toHaveLength(25);
    expect(out.total).toBe(40);
    expect(out.truncated).toBe(true);
  });
});

describe("mac_message_send — Tier 2 draft-first, fail-closed (outbound-safety)", () => {
  // The action logger is injected (the package never depends on @muse/mcp), so
  // the contract test records entries in-memory instead of reading a file.
  function makeSend(over: Partial<MacMessageSendToolDeps> = {}): { tool: ReturnType<typeof createMacMessageSendTool>; logged: MacActionLogEntry[] } {
    const logged: MacActionLogEntry[] = [];
    const tool = createMacMessageSendTool({
      actionLog: async (entry) => { logged.push(entry); },
      approvalGate: () => ({ approved: true }),
      runner: async () => ok(""),
      userId: "u1",
      ...over
    });
    return { logged, tool };
  }

  it("is a well-formed execute tool requiring to+body, grounded recipient, Korean keyword", () => {
    const { tool } = makeSend();
    expect(tool.definition.name).toBe("mac_message_send");
    expect(tool.definition.risk).toBe("execute");
    const schema = tool.definition.inputSchema as { required: string[] };
    expect(schema.required).toEqual(["body"]);
    expect(tool.definition.groundedArgs).toEqual(["to", "recipientName"]);
    expect(tool.definition.keywords).toContain("아이메시지");
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("clarifies an absent recipient WITHOUT sending or logging (recipient resolved, never guessed)", async () => {
    let sent = false;
    const { tool, logged } = makeSend({ runner: async () => { sent = true; return ok(""); } });
    expect(await tool.execute({ body: "hi", to: "  " }, ctx)).toMatchObject({ reason: "needs-recipient", sent: false });
    expect(sent).toBe(false);
    expect(logged).toEqual([]);
  });

  it("rejects an empty body WITHOUT sending", async () => {
    let sent = false;
    const { tool } = makeSend({ runner: async () => { sent = true; return ok(""); } });
    expect(await tool.execute({ body: "   ", to: "+14155551212" }, ctx)).toMatchObject({ reason: "empty-body", sent: false });
    expect(sent).toBe(false);
  });

  it("a DENIED gate produces no osascript send and logs a refused entry", async () => {
    let sent = false;
    const { tool, logged } = makeSend({
      approvalGate: () => ({ approved: false, reason: "user declined" }),
      runner: async () => { sent = true; return ok(""); }
    });
    const out = await tool.execute({ body: "ping", to: "+14155551212" }, ctx);
    expect(out).toMatchObject({ reason: "denied", sent: false });
    expect(sent).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ result: "refused" });
  });

  it("a THROWING gate (undeliverable confirm) is treated as denial — no send", async () => {
    let sent = false;
    const { tool } = makeSend({
      approvalGate: () => { throw new Error("no TTY"); },
      runner: async () => { sent = true; return ok(""); }
    });
    expect(await tool.execute({ body: "ping", to: "+14155551212" }, ctx)).toMatchObject({ reason: "denied", sent: false });
    expect(sent).toBe(false);
  });

  it("a watchdog TIMEOUT on the approved send maps to send-failed + a failed log entry", async () => {
    const { tool, logged } = makeSend({ runner: async () => timedOut });
    expect(await tool.execute({ body: "ping", to: "+14155551212" }, ctx)).toMatchObject({ reason: "send-failed", sent: false });
    expect(logged[0]).toMatchObject({ result: "failed" });
  });

  it("a CONFIRMED send fires osascript with the escaped recipient + body and logs performed", async () => {
    let script = "";
    const { tool, logged } = makeSend({ runner: async (s) => { script = s; return ok(""); } });
    const out = await tool.execute({ body: 'say "hi"', to: "jane@icloud.com" }, ctx);
    expect(out).toEqual({ sent: true, to: "jane@icloud.com" });
    expect(script).toContain('buddy "jane@icloud.com"');
    expect(script).toContain('send "say \\"hi\\""'); // body quote escaped for AppleScript
    expect(logged[0]).toMatchObject({ result: "performed" });
  });

  it("resolves a NAME via the contacts graph → sends to the resolved number (Rule 3: resolved, never guessed)", async () => {
    let script = "";
    const { tool, logged } = makeSend({
      resolveRecipient: (name) => name === "Jane" ? { name: "Jane Park", recipient: "+14155550101", status: "resolved" } : { status: "unknown" },
      runner: async (s) => { script = s; return ok(""); }
    });
    const out = await tool.execute({ body: "running late", recipientName: "Jane" }, ctx);
    expect(out).toMatchObject({ sent: true, to: "+14155550101" });
    expect(script).toContain('buddy "+14155550101"');
    expect(logged[0]).toMatchObject({ result: "performed" });
  });

  it("an AMBIGUOUS name fails closed — no osascript send, nothing logged", async () => {
    let sent = false;
    const { tool, logged } = makeSend({
      resolveRecipient: () => ({ matchCount: 2, status: "ambiguous" }),
      runner: async () => { sent = true; return ok(""); }
    });
    const out = await tool.execute({ body: "hi", recipientName: "Jane" }, ctx);
    expect(out).toMatchObject({ reason: "ambiguous-recipient", sent: false });
    expect(sent).toBe(false);
    expect(logged).toEqual([]);
  });

  it("an AMBIGUOUS name surfaces the candidate NAMES so the model can ask precisely (email parity)", async () => {
    const { tool } = makeSend({
      resolveRecipient: () => ({ candidates: ["Jane Park", "Jane Doe"], matchCount: 2, status: "ambiguous" })
    });
    const out = await tool.execute({ body: "hi", recipientName: "Jane" }, ctx) as { candidates?: string[]; detail: string; sent: boolean };
    expect(out.sent).toBe(false);
    expect(out.candidates).toEqual(["Jane Park", "Jane Doe"]);
    // the clarification names the candidates, not a vague "which one?"
    expect(out.detail).toContain("Jane Park");
    expect(out.detail).toContain("Jane Doe");
  });

  it("an UNKNOWN name fails closed (resolver consulted) — needs-recipient, no send", async () => {
    let sent = false;
    let resolverCalled = false;
    const { tool } = makeSend({
      resolveRecipient: () => { resolverCalled = true; return { status: "unknown" }; },
      runner: async () => { sent = true; return ok(""); }
    });
    expect(await tool.execute({ body: "hi", recipientName: "Ghost" }, ctx)).toMatchObject({ reason: "needs-recipient", sent: false });
    expect(resolverCalled).toBe(true);
    expect(sent).toBe(false);
  });

  it("an explicit `to` is used as-is — name resolution is NOT consulted (back-compat)", async () => {
    let resolverCalled = false;
    let script = "";
    const { tool } = makeSend({
      resolveRecipient: () => { resolverCalled = true; return { status: "unknown" }; },
      runner: async (s) => { script = s; return ok(""); }
    });
    const out = await tool.execute({ body: "hi", to: "+14155551212" }, ctx);
    expect(out).toMatchObject({ sent: true, to: "+14155551212" });
    expect(resolverCalled).toBe(false);
    expect(script).toContain('buddy "+14155551212"');
  });
});

describe("mac_screen_read — capture + local vision description", () => {
  const deps = (over: Partial<MacScreenReadToolDeps> = {}): MacScreenReadToolDeps => ({
    cleanup: async () => {},
    describeImage: async () => ({ ok: true, text: "A terminal window running tests." }),
    pathFactory: () => "/tmp/screen.png",
    readImageBase64: async () => "aW1n",
    runner: async () => ok(""),
    ...over
  });

  it("is a well-formed READ tool (observation, not an act)", () => {
    const tool = createMacScreenReadTool(deps());
    expect(tool.definition.name).toBe("mac_screen_read");
    expect(tool.definition.risk).toBe("read");
    expect(tool.definition.keywords).toContain("화면");
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("captures, describes via the injected vision callback, and cleans up the temp image", async () => {
    const calls: string[] = [];
    const tool = createMacScreenReadTool(deps({
      cleanup: async (p) => { calls.push(`cleanup:${p}`); },
      describeImage: async (input) => { calls.push(`describe:${input.mimeType}:${input.imageBase64}`); return { ok: true, text: "A terminal window running tests." }; },
      runner: async (p) => { calls.push(`capture:${p}`); return ok(""); }
    }));
    expect(await tool.execute({}, ctx)).toEqual({ described: true, text: "A terminal window running tests." });
    expect(calls).toEqual(["capture:/tmp/screen.png", "describe:image/png:aW1n", "cleanup:/tmp/screen.png"]);
  });

  it("passes the optional question through to the vision callback", async () => {
    let question: string | undefined;
    const tool = createMacScreenReadTool(deps({
      describeImage: async (input) => { question = input.question; return { ok: true, text: "Disk full error." }; }
    }));
    await tool.execute({ question: "what does the error say?" }, ctx);
    expect(question).toBe("what does the error say?");
  });

  it("a failed capture reports described:false and never calls the vision model", async () => {
    let described = false;
    const tool = createMacScreenReadTool(deps({
      describeImage: async () => { described = true; return { ok: true, text: "x" }; },
      runner: async () => fail("no screen recording permission")
    }));
    const out = await tool.execute({}, ctx);
    expect(out).toMatchObject({ described: false });
    expect(JSON.stringify(out)).toContain("permission");
    expect(described).toBe(false);
  });

  it("a vision failure reports described:false with the reason (still cleans up)", async () => {
    const calls: string[] = [];
    const tool = createMacScreenReadTool(deps({
      cleanup: async (p) => { calls.push(`cleanup:${p}`); },
      describeImage: async () => ({ error: "model offline", ok: false })
    }));
    expect(await tool.execute({}, ctx)).toMatchObject({ described: false, reason: expect.stringContaining("model offline") });
    expect(calls).toEqual(["cleanup:/tmp/screen.png"]);
  });
});
