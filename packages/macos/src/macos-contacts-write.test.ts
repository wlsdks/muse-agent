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

  it("approve → written, osascript called with the escaped name/phone/email, and a 'performed' log entry", async () => {
    let called = false;
    let scriptSeen = "";
    const runner: MacOsascriptRunner = async (script) => { called = true; scriptSeen = script; return ok(); };
    const { entries, log } = fakeLog();
    const tool = createMacContactsWriteTool({ actionLog: log, approvalGate: () => ({ approved: true }), osascript: runner });

    const result = await tool.execute({ email: "ada@example.com", name: "Ada Lovelace", phone: "+1 555 0100" }, ctx);

    expect(result).toMatchObject({ name: "Ada Lovelace", written: true });
    expect(called).toBe(true);
    expect(scriptSeen).toContain(`first name:"Ada Lovelace"`);
    expect(scriptSeen).toContain(`value:"ada@example.com"`);
    expect(scriptSeen).toContain(`value:"+1 555 0100"`);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe("performed");
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

  it("escapes an injection attempt in the name on the approved path — no raw breakout", async () => {
    let scriptSeen = "";
    const tool = createMacContactsWriteTool({
      approvalGate: () => ({ approved: true }),
      osascript: async (script) => { scriptSeen = script; return ok(); }
    });
    const maliciousName = `A" to (do shell script "x")`;

    await tool.execute({ name: maliciousName }, ctx);

    expect(scriptSeen).toContain(`first name:"A\\" to (do shell script \\"x\\")"`);
    expect(scriptSeen).not.toContain(`first name:"${maliciousName}"`);
  });
});
