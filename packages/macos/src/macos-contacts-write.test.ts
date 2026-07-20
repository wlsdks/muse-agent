import { describe, expect, it } from "vitest";

import type { MacCommandResult, MacOsascriptRunner } from "./macos-exec.js";
import { createMacContactsWriteTool, type MacContactsActionLogEntry } from "./macos-contacts-write.js";

const ctx = { runId: "r", userId: "u1" };
const ok = (stdout = ""): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });

function fakeLog(): { entries: MacContactsActionLogEntry[]; log: (entry: MacContactsActionLogEntry) => void } {
  const entries: MacContactsActionLogEntry[] = [];
  return { entries, log: (entry) => { entries.push(entry); } };
}

describe("createMacContactsWriteTool", () => {
  it("is a well-formed execute tool requiring name", () => {
    const tool = createMacContactsWriteTool({ approvalGate: () => ({ approved: true }) });
    expect(tool.definition.name).toBe("mac_contacts_write");
    expect(tool.definition.risk).toBe("execute");
    expect((tool.definition.inputSchema as { required: string[] }).required).toEqual(["name"]);
  });

  it("approve → written, name/phone/email passed as ARGV, and a 'performed' log entry", async () => {
    let called = false;
    let scriptSeen = "";
    let argsSeen: readonly string[] | undefined;
    const runner: MacOsascriptRunner = async (script, args) => { called = true; scriptSeen = script; argsSeen = args; return ok(); };
    const { entries, log } = fakeLog();
    const tool = createMacContactsWriteTool({ actionLog: log, approvalGate: () => ({ approved: true }), osascript: runner });

    const result = await tool.execute({ email: "ada@example.com", name: "Ada Lovelace", phone: "+1 555 0100" }, ctx);

    expect(result).toMatchObject({ name: "Ada Lovelace", written: true });
    expect(called).toBe(true);
    expect(argsSeen).toEqual(["Ada Lovelace", "+1 555 0100", "ada@example.com"]);
    // None of the field values appear in the script source.
    expect(scriptSeen).not.toContain("Ada Lovelace");
    expect(scriptSeen).not.toContain("ada@example.com");
    expect(scriptSeen).toContain("on run argv");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe("performed");
  });

  it("reports a completed write when post-write audit logging fails, so a caller does not retry and duplicate the contact", async () => {
    let called = false;
    const tool = createMacContactsWriteTool({
      actionLog: async () => { throw new Error("action log unavailable"); },
      approvalGate: () => ({ approved: true }),
      osascript: async () => { called = true; return ok(); }
    });

    const result = await tool.execute({ name: "Ada Lovelace" }, ctx);

    expect(called).toBe(true);
    expect(result).toMatchObject({ auditLogged: false, name: "Ada Lovelace", written: true });
  });

  it("DENY → NO write (the core outbound-safety assertion): osascript never called, written:false, 'refused' logged", async () => {
    let called = false;
    const runner: MacOsascriptRunner = async () => { called = true; return ok(); };
    const { entries, log } = fakeLog();
    const tool = createMacContactsWriteTool({
      actionLog: log,
      approvalGate: () => ({ approved: false, reason: "user declined" }),
      osascript: runner
    });

    const result = await tool.execute({ name: "Ada Lovelace" }, ctx);

    expect(result).toMatchObject({ written: false });
    expect((result as { detail?: string }).detail).toContain("declined");
    expect(called).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe("refused");
  });

  it("gate THROWS → NO write", async () => {
    let called = false;
    const runner: MacOsascriptRunner = async () => { called = true; return ok(); };
    const { entries, log } = fakeLog();
    const tool = createMacContactsWriteTool({
      actionLog: log,
      approvalGate: () => { throw new Error("no tty"); },
      osascript: runner
    });

    const result = await tool.execute({ name: "Ada Lovelace" }, ctx);

    expect(result).toMatchObject({ written: false });
    expect(called).toBe(false);
    expect(entries[0]?.result).toBe("refused");
  });

  it("blank name → refused before the gate or osascript ever run", async () => {
    let gateCalled = false;
    let osaCalled = false;
    const tool = createMacContactsWriteTool({
      approvalGate: () => { gateCalled = true; return { approved: true }; },
      osascript: async () => { osaCalled = true; return ok(); }
    });

    const result = await tool.execute({ name: "   " }, ctx);

    expect(result).toMatchObject({ reason: "empty-name", written: false });
    expect(gateCalled).toBe(false);
    expect(osaCalled).toBe(false);
  });

  it("an injection attempt in the name stays inert data — it never enters the script source", async () => {
    let scriptSeen = "";
    let argsSeen: readonly string[] | undefined;
    const tool = createMacContactsWriteTool({
      approvalGate: () => ({ approved: true }),
      osascript: async (script, args) => { scriptSeen = script; argsSeen = args; return ok(); }
    });
    const maliciousName = `A" to (do shell script "x")`;

    await tool.execute({ name: maliciousName }, ctx);

    // Stronger than the old escaping assertion: the payload is not escaped INTO
    // the script, it is not in the script at all. There is no quoting bug to
    // have, because there is no quoting.
    expect(argsSeen?.[0]).toBe(maliciousName);
    expect(scriptSeen).not.toContain("do shell script");
    expect(scriptSeen).not.toContain(maliciousName);
  });
});
