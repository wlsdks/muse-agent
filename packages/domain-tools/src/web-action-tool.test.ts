import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWebActionTool } from "./web-action-tool.js";
import type { WebActionApprovalGate } from "./web-action.js";
import { validateToolDefinitions } from "@muse/tools";

import { readActionLog } from "@muse/stores";

function recordingFetch(): { fetchImpl: typeof fetch; calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: { method?: string }) => {
    calls.push({ method: init?.method ?? "GET", url: String(url) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const approve: WebActionApprovalGate = () => ({ approved: true });
const deny: WebActionApprovalGate = () => ({ approved: false, reason: "declined" });

// Test resolver: every host maps to a public IP so the SSRF guard passes
// for `.test` hosts (which real DNS would not resolve).
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-web-tool-")), "action-log.json");
}

const ctx = { runId: "run-1", userId: "stark" };

describe("createWebActionTool", () => {
  it("exposes an execute-risk web_action tool requiring only summary (url resolved/clarified, never guessed)", () => {
    const { fetchImpl } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, userId: "stark" });
    expect(tool.definition.name).toBe("web_action");
    expect(tool.definition.risk).toBe("execute");
    expect(tool.definition.inputSchema.required).toEqual(["summary"]);
    expect(tool.definition.inputSchema.properties).toHaveProperty("url");
  });

  it("its inputSchema is validateToolDefinitions-clean + closed (additionalProperties:false) and carries the Korean selection keyword 예약", () => {
    const { fetchImpl } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, userId: "stark" });
    expect((tool.definition.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    expect(tool.definition.keywords).toContain("예약");
    expect(validateToolDefinitions([tool])).toEqual([]);
  });

  it("its description tells the model when to use it AND when NOT (read / payments)", () => {
    const { fetchImpl } = recordingFetch();
    const d = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, userId: "stark" }).definition.description.toLowerCase();
    expect(d).toContain("use when");
    expect(d).toContain("do not use to read");
    expect(d).toContain("payments");
  });

  it("CONFIRM: performs the request and reports performed", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const actionLogFile = logFile();
    const tool = createWebActionTool({ actionLogFile, approvalGate: approve, fetchImpl, lookup: publicLookup, userId: "stark" });
    const out = await tool.execute({ body: "{}", summary: "Book a table", url: "https://book.test/x" }, ctx);
    expect(out).toEqual({ performed: true, status: 200 });
    expect(calls).toEqual([{ method: "POST", url: "https://book.test/x" }]);
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "performed" });
  });

  it("rejects a non-state-changing method (GET) BEFORE any HTTP — a read verb can't masquerade as a performed action", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, lookup: publicLookup, userId: "stark" });
    const out = await tool.execute({ summary: "Book a table", url: "https://book.test/x", method: "GET" }, ctx);
    expect(out).toMatchObject({ performed: false, reason: "invalid-method" });
    expect(calls).toHaveLength(0); // the GET no-op never fires (no false `performed:true`)
  });

  it("rejects a garbage method BEFORE any HTTP (caught as a bad arg, not an opaque fetch/405)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, lookup: publicLookup, userId: "stark" });
    const out = await tool.execute({ summary: "Submit the form", url: "https://book.test/x", method: "frobnicate" }, ctx);
    expect(out).toMatchObject({ performed: false, reason: "invalid-method" });
    expect(calls).toHaveLength(0);
  });

  it("accepts a valid state-changing method case-insensitively (put → PUT)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, lookup: publicLookup, userId: "stark" });
    await tool.execute({ body: "{}", summary: "Update the RSVP", url: "https://book.test/x", method: "put" }, ctx);
    expect(calls).toEqual([{ method: "PUT", url: "https://book.test/x" }]);
  });

  it("DENY: no request fires", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: deny, fetchImpl, lookup: publicLookup, userId: "stark" });
    const out = await tool.execute({ summary: "Book", url: "https://book.test/x" }, ctx);
    expect(out).toMatchObject({ performed: false, reason: "denied" });
    expect(calls).toHaveLength(0);
  });

  it("CLARIFY: an absent url asks for one and fires no request (destination resolved, never guessed)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, userId: "stark" });
    const variants: Record<string, string>[] = [{ summary: "Post a comment" }, { summary: "Post a comment", url: "" }, { summary: "Post a comment", url: "   " }];
    for (const args of variants) {
      const out = await tool.execute(args, ctx) as Record<string, unknown>;
      expect(out.performed).toBe(false);
      expect(out.reason).toBe("needs-url");
      expect(typeof out.detail).toBe("string");
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing summary without firing", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, userId: "stark" });
    const out = await tool.execute({ summary: "", url: "https://book.test/x" }, ctx) as Record<string, unknown>;
    expect(out.performed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("SSRF: a loopback URL is refused before any HTTP or approval", async () => {
    const { fetchImpl, calls } = recordingFetch();
    let approvalAsked = false;
    const watchGate: WebActionApprovalGate = () => { approvalAsked = true; return { approved: true }; };
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: watchGate, fetchImpl, userId: "stark" });
    const out = await tool.execute({ summary: "Hit admin", url: "http://127.0.0.1/admin" }, ctx) as Record<string, unknown>;
    expect(out.performed).toBe(false);
    expect(String(out.reason)).toContain("unsafe");
    expect(calls).toHaveLength(0);
    expect(approvalAsked).toBe(false);
  });

  it("SSRF: the cloud metadata link-local endpoint is refused", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, userId: "stark" });
    const out = await tool.execute({ summary: "Steal creds", url: "http://169.254.169.254/latest/meta-data/" }, ctx) as Record<string, unknown>;
    expect(out.performed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("SSRF: a non-http(s) protocol is refused", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, userId: "stark" });
    const out = await tool.execute({ summary: "Read a file", url: "file:///etc/passwd" }, ctx) as Record<string, unknown>;
    expect(out.performed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a host that resolves to a PRIVATE address is refused (DNS-rebinding guard)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const privateLookup = async () => [{ address: "10.0.0.5", family: 4 }];
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, lookup: privateLookup, userId: "stark" });
    const out = await tool.execute({ summary: "Internal", url: "https://intranet.example.com/x" }, ctx) as Record<string, unknown>;
    expect(out.performed).toBe(false);
    expect(calls).toHaveLength(0);
  });

});
