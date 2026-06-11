import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateToolDefinitions } from "@muse/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMacAppOpenTool,
  createMacAppReadTool,
  createMacMessageSendTool,
  createMacShortcutRunTool,
  type MacCommandResult,
  type MacMessageSendToolDeps,
  type MacOsascriptRunner,
  type ShortcutsRunner
} from "../src/macos-tools.js";
import { readActionLog } from "../src/personal-action-log-store.js";

const ctx = { runId: "r", userId: "u1" };
const ok = (stdout: string): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });
const fail = (stderr: string, exitCode = 1): MacCommandResult => ({ exitCode, stderr, stdout: "", timedOut: false });
const timedOut: MacCommandResult = { exitCode: null, stderr: "", stdout: "", timedOut: true };

let dir: string;
let actionLogFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-macos-tool-"));
  actionLogFile = join(dir, "actions.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

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
    await tool.execute({ target: "~/report.pdf" }, ctx);
    expect(argv).toEqual(["~/report.pdf"]);
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
});

describe("mac_message_send — Tier 2 draft-first, fail-closed (outbound-safety)", () => {
  const deps = (over: Partial<MacMessageSendToolDeps> = {}): MacMessageSendToolDeps => ({
    actionLogFile,
    approvalGate: () => ({ approved: true }),
    runner: async () => ok(""),
    userId: "u1",
    ...over
  });

  it("is a well-formed execute tool requiring to+body, grounded recipient, Korean keyword", () => {
    const tool = createMacMessageSendTool(deps());
    expect(tool.definition.name).toBe("mac_message_send");
    expect(tool.definition.risk).toBe("execute");
    const schema = tool.definition.inputSchema as { required: string[] };
    expect(schema.required).toEqual(["to", "body"]);
    expect(tool.definition.groundedArgs).toEqual(["to"]);
    expect(tool.definition.keywords).toContain("아이메시지");
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("clarifies an absent recipient WITHOUT sending or logging (recipient resolved, never guessed)", async () => {
    let sent = false;
    const tool = createMacMessageSendTool(deps({ runner: async () => { sent = true; return ok(""); } }));
    expect(await tool.execute({ body: "hi", to: "  " }, ctx)).toMatchObject({ reason: "needs-recipient", sent: false });
    expect(sent).toBe(false);
    expect(await readActionLog(actionLogFile)).toEqual([]);
  });

  it("rejects an empty body WITHOUT sending", async () => {
    let sent = false;
    const tool = createMacMessageSendTool(deps({ runner: async () => { sent = true; return ok(""); } }));
    expect(await tool.execute({ body: "   ", to: "+14155551212" }, ctx)).toMatchObject({ reason: "empty-body", sent: false });
    expect(sent).toBe(false);
  });

  it("a DENIED gate produces no osascript send and logs a refused entry", async () => {
    let sent = false;
    const tool = createMacMessageSendTool(deps({
      approvalGate: () => ({ approved: false, reason: "user declined" }),
      runner: async () => { sent = true; return ok(""); }
    }));
    const out = await tool.execute({ body: "ping", to: "+14155551212" }, ctx);
    expect(out).toMatchObject({ reason: "denied", sent: false });
    expect(sent).toBe(false);
    const log = await readActionLog(actionLogFile);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ result: "refused" });
  });

  it("a THROWING gate (undeliverable confirm) is treated as denial — no send", async () => {
    let sent = false;
    const tool = createMacMessageSendTool(deps({
      approvalGate: () => { throw new Error("no TTY"); },
      runner: async () => { sent = true; return ok(""); }
    }));
    expect(await tool.execute({ body: "ping", to: "+14155551212" }, ctx)).toMatchObject({ reason: "denied", sent: false });
    expect(sent).toBe(false);
  });

  it("a watchdog TIMEOUT on the approved send maps to send-failed + a failed log entry", async () => {
    const tool = createMacMessageSendTool(deps({ runner: async () => timedOut }));
    expect(await tool.execute({ body: "ping", to: "+14155551212" }, ctx)).toMatchObject({ reason: "send-failed", sent: false });
    const log = await readActionLog(actionLogFile);
    expect(log[0]).toMatchObject({ result: "failed" });
  });

  it("a CONFIRMED send fires osascript with the escaped recipient + body and logs performed", async () => {
    let script = "";
    const tool = createMacMessageSendTool(deps({ runner: async (s) => { script = s; return ok(""); } }));
    const out = await tool.execute({ body: 'say "hi"', to: "jane@icloud.com" }, ctx);
    expect(out).toEqual({ sent: true, to: "jane@icloud.com" });
    expect(script).toContain('buddy "jane@icloud.com"');
    expect(script).toContain('send "say \\"hi\\""'); // body quote escaped for AppleScript
    const log = await readActionLog(actionLogFile);
    expect(log[0]).toMatchObject({ result: "performed" });
  });
});
