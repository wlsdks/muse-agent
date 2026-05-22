import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWebActionTool } from "./web-action-tool.js";
import type { WebActionApprovalGate } from "./web-action.js";
import { readActionLog } from "./personal-action-log-store.js";

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

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-web-tool-")), "action-log.json");
}

const ctx = { runId: "run-1", userId: "stark" };

describe("createWebActionTool", () => {
  it("exposes an execute-risk web_action tool requiring summary + url", () => {
    const { fetchImpl } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, userId: "stark" });
    expect(tool.definition.name).toBe("web_action");
    expect(tool.definition.risk).toBe("execute");
    expect(tool.definition.inputSchema.required).toEqual(["summary", "url"]);
  });

  it("CONFIRM: performs the request and reports performed", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const actionLogFile = logFile();
    const tool = createWebActionTool({ actionLogFile, approvalGate: approve, fetchImpl, userId: "stark" });
    const out = await tool.execute({ body: "{}", summary: "Book a table", url: "https://book.test/x" }, ctx);
    expect(out).toEqual({ performed: true, status: 200 });
    expect(calls).toEqual([{ method: "POST", url: "https://book.test/x" }]);
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "performed" });
  });

  it("DENY: no request fires", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: deny, fetchImpl, userId: "stark" });
    const out = await tool.execute({ summary: "Book", url: "https://book.test/x" }, ctx);
    expect(out).toMatchObject({ performed: false, reason: "denied" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing url/summary without firing", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const tool = createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, userId: "stark" });
    const out = await tool.execute({ summary: "Book", url: "" }, ctx) as Record<string, unknown>;
    expect(out.performed).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
