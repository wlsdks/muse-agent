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

  it("does NOT follow a 3xx redirect on a state-changing action (SSRF: the URL guard only vetted the ORIGINAL host)", async () => {
    // A real fetch with the default redirect:"follow" would transparently re-issue
    // the POST to the redirect target — a 307/308 re-sends the body — so a vetted
    // public URL that 302s to 127.0.0.1 / 169.254.169.254 would hit the private host.
    // This fake mirrors real fetch: it only "follows" (returns the 200) when the
    // caller did NOT pass redirect:"manual".
    const calls: { url: string; redirect: unknown }[] = [];
    const fetchImpl = (async (url: string | URL, init?: { redirect?: string }) => {
      calls.push({ redirect: init?.redirect, url: String(url) });
      if (init?.redirect === "manual") {
        return new Response(null, { headers: { location: "http://127.0.0.1/admin" }, status: 302 });
      }
      return new Response("{}", { status: 200 }); // default-follow lands on the private host and "succeeds"
    }) as unknown as typeof fetch;
    const actionLogFile = logFile();
    const outcome = await performWebActionWithApproval({
      actionLogFile, approvalGate: approve, fetchImpl, request, summary: "Book a table, 7pm", userId: "stark"
    });
    expect(outcome).toMatchObject({ performed: false, reason: "failed" });
    expect(calls[0]?.redirect).toBe("manual"); // the fix disables auto-follow so real fetch never reaches the private host
    expect(String((outcome as { detail?: string }).detail ?? "")).toMatch(/127\.0\.0\.1|redirect/i);
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

describe("performWebActionWithApproval — 429-only safe retry (idempotent actuators opt in)", () => {
  // Serves a scripted status sequence + counts transmits, so a double-act shows
  // as an extra call. Contract-faithful (real Response objects), never a flag.
  function sequencedFetch(statuses: { status: number; retryAfter?: string }[]): { fetchImpl: typeof fetch; calls: () => number } {
    let i = 0;
    const fetchImpl = (async () => {
      const s = statuses[Math.min(i, statuses.length - 1)]!;
      i += 1;
      return new Response("{}", { status: s.status, ...(s.retryAfter ? { headers: { "retry-after": s.retryAfter } } : {}) });
    }) as unknown as typeof fetch;
    return { calls: () => i, fetchImpl };
  }

  it("retryOn429: RETRIES a 429 then performs, honouring Retry-After — approval runs ONCE (re-transmit, never re-approve)", async () => {
    const slept: number[] = [];
    let approvals = 0;
    const gate: WebActionApprovalGate = () => { approvals += 1; return { approved: true }; };
    const fake = sequencedFetch([{ retryAfter: "2", status: 429 }, { status: 200 }]);
    const outcome = await performWebActionWithApproval({
      actionLogFile: logFile(), approvalGate: gate, fetchImpl: fake.fetchImpl, request, summary: "set thermostat 21C", userId: "stark",
      retryOn429: true, sleep: async (ms) => { slept.push(ms); }
    });
    expect(outcome).toMatchObject({ performed: true });
    expect(fake.calls()).toBe(2); // one 429 + one success
    expect(approvals).toBe(1);
    expect(slept).toEqual([2000]); // honoured Retry-After (2s), not the 250ms backoff
  });

  it("retryOn429: a 5xx is NEVER retried (ambiguous — the action may have applied), single attempt", async () => {
    const fake = sequencedFetch([{ status: 503 }]);
    const outcome = await performWebActionWithApproval({
      actionLogFile: logFile(), approvalGate: approve, fetchImpl: fake.fetchImpl, request, summary: "x", userId: "stark",
      retryOn429: true, sleep: async () => {}
    });
    expect(outcome).toMatchObject({ performed: false, reason: "failed" });
    expect(fake.calls()).toBe(1);
  });

  it("WITHOUT retryOn429 a 429 is single-shot — a generic non-idempotent web submit never auto-retries", async () => {
    const fake = sequencedFetch([{ status: 429 }, { status: 200 }]);
    const outcome = await performWebActionWithApproval({
      actionLogFile: logFile(), approvalGate: approve, fetchImpl: fake.fetchImpl, request, summary: "book a table", userId: "stark"
    });
    expect(outcome).toMatchObject({ performed: false, reason: "failed" });
    expect(fake.calls()).toBe(1);
  });
});
