import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readActionLog } from "../src/personal-action-log-store.js";
import { performWebActionWithApproval, type PerformWebActionWithApprovalOptions } from "../src/web-action.js";

let dir: string;
let logFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-web-action-"));
  logFile = join(dir, "actions.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const okFetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
const base = (over: Partial<PerformWebActionWithApprovalOptions> = {}): PerformWebActionWithApprovalOptions => ({
  actionLogFile: logFile,
  approvalGate: () => ({ approved: true }),
  fetchImpl: okFetch,
  request: { body: '{"time":"19:00"}', method: "POST", url: "https://api.test/book" },
  summary: "Book a table at 7pm",
  userId: "u1",
  ...over
});

describe("performWebActionWithApproval — draft-first, fail-closed web action (outbound-safety.md)", () => {
  it("CONFIRMED: fires the request EXACTLY ONCE with the confirmed method/body and reports performed", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let sawAction: { summary: string } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ init, url }); return new Response("", { status: 201 }); }) as unknown as typeof fetch;
    const out = await performWebActionWithApproval(base({
      approvalGate: (action) => { sawAction = action; return { approved: true }; },
      fetchImpl
    }));
    expect(out).toEqual({ performed: true, status: 201 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe('{"time":"19:00"}');
    expect(sawAction!.summary).toBe("Book a table at 7pm"); // draft-first: gate saw the exact action
    expect((await readActionLog(logFile)).at(-1)).toMatchObject({ result: "performed" });
  });

  it("DENIED: makes NO HTTP request and logs the refusal", async () => {
    let fetched = false;
    const fetchImpl = (async () => { fetched = true; return new Response(""); }) as unknown as typeof fetch;
    const out = await performWebActionWithApproval(base({ approvalGate: () => ({ approved: false, reason: "user declined" }), fetchImpl }));
    expect(out).toMatchObject({ performed: false, reason: "denied" });
    expect(fetched).toBe(false);
    expect((await readActionLog(logFile)).at(-1)).toMatchObject({ result: "refused" });
  });

  it("GATE THROWS: fail-closed — no HTTP request", async () => {
    let fetched = false;
    const fetchImpl = (async () => { fetched = true; return new Response(""); }) as unknown as typeof fetch;
    const out = await performWebActionWithApproval(base({ approvalGate: () => { throw new Error("prompt down"); }, fetchImpl }));
    expect(out).toMatchObject({ performed: false, reason: "denied" });
    expect((out as { detail: string }).detail).toContain("approval gate error");
    expect(fetched).toBe(false);
  });

  it("NON-2xx: classifies a server rejection as FAILED, never a false 'performed' the user acts on", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const out = await performWebActionWithApproval(base({ fetchImpl }));
    expect(out).toMatchObject({ performed: false, reason: "failed" });
    expect((out as { detail: string }).detail).toContain("HTTP 403");
    expect((await readActionLog(logFile)).at(-1)).toMatchObject({ result: "failed" });
  });

  it("transport error: reason failed with the underlying detail", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const out = await performWebActionWithApproval(base({ fetchImpl }));
    expect(out).toMatchObject({ performed: false, reason: "failed" });
    expect((out as { detail: string }).detail).toContain("ECONNREFUSED");
  });

  it("times out via AbortController once the wall-clock cap passes (no hung approved action)", async () => {
    const hangUntilAbort = ((url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const out = await performWebActionWithApproval(base({ fetchImpl: hangUntilAbort, timeoutMs: 5 }));
    expect(out).toMatchObject({ performed: false, reason: "timed-out" });
    expect((out as { detail: string }).detail).toContain("timed out");
  });

  it("records the (redacted) request body in the action log entry", async () => {
    await performWebActionWithApproval(base({ request: { body: "key sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa", method: "POST", url: "https://api.test/x" } }));
    const entry = (await readActionLog(logFile)).at(-1);
    expect(entry!.what).toContain("web action: Book a table at 7pm");
    expect(entry!.what).not.toContain("sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(entry!.what).toContain("[redacted-anthropic-key]");
  });
});
