import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { performWebActionWithApproval, type WebActionApprovalGate } from "./web-action.js";
import { readActionLog } from "./personal-action-log-store.js";

// Records every HTTP call so a test can assert the action fired (or
// didn't) and carried the real request shape. Never a "did it" flag.
function recordingFetch(status = 200): { fetchImpl: typeof fetch; calls: { url: string; method: string; body?: string }[] } {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: { method?: string; body?: string }) => {
    calls.push({ body: init?.body, method: init?.method ?? "GET", url: String(url) });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const approve: WebActionApprovalGate = () => ({ approved: true });
const deny: WebActionApprovalGate = () => ({ approved: false, reason: "user declined" });
const throwingGate: WebActionApprovalGate = () => { throw new Error("approval prompt undeliverable"); };

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-web-action-")), "action-log.json");
}

const request = { body: JSON.stringify({ time: "19:00" }), method: "POST", url: "https://book.test/reserve" };

describe("performWebActionWithApproval — outbound-safety contract", () => {
  it("CONFIRM: the HTTP action fires once with the real request shape, logged `performed`", async () => {
    const { fetchImpl, calls } = recordingFetch(201);
    const actionLogFile = logFile();
    const outcome = await performWebActionWithApproval({
      actionLogFile, approvalGate: approve, fetchImpl, request, summary: "Book a table, 7pm", userId: "stark"
    });
    expect(outcome).toEqual({ performed: true, status: 201 });
    expect(calls).toEqual([{ body: JSON.stringify({ time: "19:00" }), method: "POST", url: "https://book.test/reserve" }]);
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "performed" });
  });

  it("DENY: no HTTP fires, refusal logged", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const actionLogFile = logFile();
    const outcome = await performWebActionWithApproval({
      actionLogFile, approvalGate: deny, fetchImpl, request, summary: "Book a table", userId: "stark"
    });
    expect(outcome).toMatchObject({ performed: false, reason: "denied" });
    expect(calls).toHaveLength(0);
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "refused" });
  });

  it("TIMEOUT / gate error: fail-closed — no HTTP fires", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const outcome = await performWebActionWithApproval({
      actionLogFile: logFile(), approvalGate: throwingGate, fetchImpl, request, summary: "Book", userId: "stark"
    });
    expect(outcome).toMatchObject({ performed: false, reason: "denied" });
    expect(calls).toHaveLength(0);
  });

  it("never autonomous: with no approval the request is blocked even though a transport is available", async () => {
    const { fetchImpl, calls } = recordingFetch();
    await performWebActionWithApproval({
      actionLogFile: logFile(), approvalGate: () => ({ approved: false }), fetchImpl, request, summary: "x", userId: "stark"
    });
    expect(calls).toHaveLength(0);
  });
});
