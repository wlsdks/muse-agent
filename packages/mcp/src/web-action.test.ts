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

  it("server rejection (non-2xx): reports failed, NOT a false `performed` success, logged failed", async () => {
    const { fetchImpl, calls } = recordingFetch(500);
    const actionLogFile = logFile();
    const outcome = await performWebActionWithApproval({
      actionLogFile, approvalGate: approve, fetchImpl, request, summary: "Book a table, 7pm", userId: "stark"
    });
    expect(outcome).toMatchObject({ performed: false, reason: "failed" });
    expect((outcome as { detail: string }).detail).toContain("HTTP 500");
    expect(calls).toHaveLength(1); // the request DID fire — but it was rejected, never retried
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "failed" });
  });

  it("a 403 (forbidden) is also a rejection, not performed", async () => {
    const { fetchImpl } = recordingFetch(403);
    const outcome = await performWebActionWithApproval({
      actionLogFile: logFile(), approvalGate: approve, fetchImpl, request, summary: "Book", userId: "stark"
    });
    expect(outcome.performed).toBe(false);
  });

  it("a network reject AFTER approval (e.g. ECONNRESET): reason `failed`, NOT a false success, logged failed", async () => {
    // The approved transport throws WITHOUT the timeout firing — a transient
    // connection error. It must classify as `failed` (distinct from a `timed-out`
    // abort), never `performed`, and the action log must still record the attempt.
    const actionLogFile = logFile();
    const fetchImpl = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const outcome = await performWebActionWithApproval({
      actionLogFile, approvalGate: approve, fetchImpl, request, summary: "Book", userId: "stark"
    });
    expect(outcome).toMatchObject({ performed: false, reason: "failed" });
    expect((outcome as { detail: string }).detail).toContain("ECONNRESET");
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "failed" });
  });

  it("a transport TIMEOUT (per-attempt abort fires): reason `timed-out`, logged failed, no false success", async () => {
    // The transport honours the AbortSignal and never responds; the timeout
    // controller aborts it. This is the `timed-out` branch — a slow third party,
    // distinct from an outright connection error — and must not report performed.
    const actionLogFile = logFile();
    const fetchImpl = ((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => { reject(new Error("aborted")); });
    })) as unknown as typeof fetch;
    const outcome = await performWebActionWithApproval({
      actionLogFile, approvalGate: approve, fetchImpl, request, summary: "Book", timeoutMs: 5, userId: "stark"
    });
    expect(outcome).toMatchObject({ performed: false, reason: "timed-out" });
    expect((outcome as { detail: string }).detail).toContain("timed out");
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "failed" });
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

  it("records the submitted body in the action log (outbound-safety rule 4 — the exact content), for performed AND refused", async () => {
    const performedLog = logFile();
    await performWebActionWithApproval({
      actionLogFile: performedLog, approvalGate: approve, fetchImpl: recordingFetch(200).fetchImpl,
      request: { body: JSON.stringify({ time: "19:00" }), method: "POST", url: "https://book.test/reserve" },
      summary: "Book a table, 7pm", userId: "stark"
    });
    expect((await readActionLog(performedLog))[0]!.what).toContain('body: {"time":"19:00"}');

    const refusedLog = logFile();
    await performWebActionWithApproval({
      actionLogFile: refusedLog, approvalGate: deny, fetchImpl: recordingFetch().fetchImpl,
      request: { body: JSON.stringify({ time: "19:00" }), method: "POST", url: "https://book.test/reserve" },
      summary: "Book a table", userId: "stark"
    });
    // What WOULD have been submitted is recorded on the refusal too.
    expect((await readActionLog(refusedLog))[0]!.what).toContain('body: {"time":"19:00"}');
  });

  it("scrubs secrets out of the logged body (the action log is long-lived / may sync)", async () => {
    const secret = `123456:${"A".repeat(35)}`; // telegram-bot-token shaped
    const actionLogFile = logFile();
    await performWebActionWithApproval({
      actionLogFile, approvalGate: approve, fetchImpl: recordingFetch(200).fetchImpl,
      request: { body: `token=${secret}`, method: "POST", url: "https://hook.test/post" },
      summary: "Post update", userId: "stark"
    });
    const what = (await readActionLog(actionLogFile))[0]!.what;
    expect(what).not.toContain(secret);
    expect(what).toContain("[redacted-telegram-bot-token]");
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
