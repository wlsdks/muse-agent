import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "@muse/shared";
import { describe, expect, it } from "vitest";

import type { Contact } from "@muse/stores";
import { readActionLog } from "@muse/stores";
import { runActuatorByName, type RunActuatorByNameDeps } from "./run-actuator-by-name.js";

function recordingFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-run-actuator-")), "action-log.json");
}

const approveEmail = () => ({ approved: true });
const approveWeb = () => ({ approved: true });
const denyWeb = () => ({ approved: false, reason: "declined" });
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function deps(overrides: Partial<RunActuatorByNameDeps> & { fetchImpl: typeof fetch }): RunActuatorByNameDeps {
  return {
    actionLogFile: logFile(),
    emailApprovalGate: approveEmail,
    lookup: publicLookup,
    userId: "stark",
    webApprovalGate: approveWeb,
    ...overrides
  };
}

describe("runActuatorByName", () => {
  it("web_action: approve → one request fires, ran:true", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const result = await runActuatorByName("web_action", { summary: "Book", url: "http://x.test/book" } as JsonObject, deps({ fetchImpl }));
    expect(result).toEqual({ ran: true });
    expect(calls).toEqual(["http://x.test/book"]);
  });

  it("web_action: deny → no request, ran:false declined", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const result = await runActuatorByName("web_action", { summary: "Book", url: "http://x.test/book" } as JsonObject, deps({ fetchImpl, webApprovalGate: denyWeb }));
    expect(result.ran).toBe(false);
    expect((result as { reason: string }).reason).toBe("declined");
    expect(calls).toHaveLength(0);
  });

  it("home_action: approve → one HA service POST fires", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const result = await runActuatorByName(
      "home_action",
      { entity: "light.living_room", service: "light.turn_off" } as JsonObject,
      deps({ fetchImpl, homeAssistantBaseUrl: "http://ha.local:8123", homeAssistantToken: "tok" })
    );
    expect(result).toEqual({ ran: true });
    expect(calls).toEqual(["http://ha.local:8123/api/services/light/turn_off"]);
  });

  it("email_send: approve → real Gmail send (HTTP-faked), ran:true; resolves the recipient via contacts", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const contacts: readonly Contact[] = [{ id: "c1", name: "Bob", email: "bob@example.com" }];
    const result = await runActuatorByName(
      "email_send",
      { body: "hi", subject: "Q3", to: "Bob" } as JsonObject,
      deps({ contacts: () => contacts, fetchImpl, gmailToken: "gtok" })
    );
    expect(result).toEqual({ ran: true });
    expect(calls.some((u) => u.includes("/messages/send"))).toBe(true);
  });

  it("email_send without a gmail token / contacts → unavailable (no fire)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const result = await runActuatorByName("email_send", { body: "x", subject: "x", to: "Bob" } as JsonObject, deps({ fetchImpl }));
    expect(result).toMatchObject({ ran: false, reason: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("home_action without HA config → unavailable (no fire)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const result = await runActuatorByName("home_action", { service: "light.turn_off" } as JsonObject, deps({ fetchImpl }));
    expect(result).toMatchObject({ ran: false, reason: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("an unknown tool name → unknown-tool (no fire)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const result = await runActuatorByName("muse.notes.save", {} as JsonObject, deps({ fetchImpl }));
    expect(result).toMatchObject({ ran: false, reason: "unknown-tool" });
    expect(calls).toHaveLength(0);
  });
});

// outbound-safety.md acceptance at the actuator-DISPATCHER level (backlog P2
// approval round-trip). The cases above assert the external HTTP effect; these
// add the "recorded + reversible-where-possible" rule (#4) — every outcome,
// performed OR refused OR failed, lands a rationale-bearing action-log entry —
// and close the dispatcher-level fail-closed paths (a thrown/undeliverable
// approval prompt, an ambiguous recipient, a third-party rejection) the leg-level
// email-send tests prove but `runActuatorByName` did not. Contract-faithful HTTP
// fake throughout — never a stubbed registry.
describe("runActuatorByName — outbound-safety acceptance + action log", () => {
  // a status-controllable recording fetch (default 200) so we can drive a 5xx.
  const recordingFetchStatus = (status = 200): { fetchImpl: typeof fetch; calls: string[] } => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => { calls.push(String(url)); return new Response("{}", { status }); }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };
  const throwingWeb = () => { throw new Error("approval prompt undeliverable"); };

  it("web_action APPROVE → action logged `performed` (recorded for review), one request fires", async () => {
    const { fetchImpl, calls } = recordingFetchStatus();
    const file = logFile();
    const result = await runActuatorByName("web_action", { summary: "Book a table", url: "http://x.test/book" } as JsonObject, deps({ actionLogFile: file, fetchImpl }));
    expect(result).toEqual({ ran: true });
    expect(calls).toEqual(["http://x.test/book"]);
    const log = await readActionLog(file);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ result: "performed", userId: "stark" });
  });

  it("web_action DENY → action logged `refused`, no request fires", async () => {
    const { fetchImpl, calls } = recordingFetchStatus();
    const file = logFile();
    const result = await runActuatorByName("web_action", { summary: "Book", url: "http://x.test/book" } as JsonObject, deps({ actionLogFile: file, fetchImpl, webApprovalGate: denyWeb }));
    expect(result).toMatchObject({ ran: false, reason: "declined" });
    expect(calls).toHaveLength(0);
    expect((await readActionLog(file)).map((e) => e.result)).toEqual(["refused"]);
  });

  it("web_action with a THROWING/undeliverable approval prompt is fail-closed: no request, logged `refused`", async () => {
    const { fetchImpl, calls } = recordingFetchStatus();
    const file = logFile();
    const result = await runActuatorByName("web_action", { summary: "Book", url: "http://x.test/book" } as JsonObject, deps({ actionLogFile: file, fetchImpl, webApprovalGate: throwingWeb }));
    expect(result).toMatchObject({ ran: false, reason: "declined" });
    expect(calls).toHaveLength(0); // a failed confirmation NEVER lets the action through
    expect((await readActionLog(file)).map((e) => e.result)).toEqual(["refused"]);
  });

  it("web_action where the third party REJECTS (HTTP 500) → NOT a false success: ran:false failed, logged `failed`", async () => {
    const { fetchImpl, calls } = recordingFetchStatus(500);
    const file = logFile();
    const result = await runActuatorByName("web_action", { summary: "Book", url: "http://x.test/book" } as JsonObject, deps({ actionLogFile: file, fetchImpl }));
    expect(result).toMatchObject({ ran: false, reason: "failed" });
    expect((result as { detail: string }).detail).toContain("HTTP 500"); // the failure detail surfaces the upstream status
    expect(calls).toEqual(["http://x.test/book"]); // the attempt fired once (no retry — a retried POST can double-act)
    expect((await readActionLog(file)).map((e) => e.result)).toEqual(["failed"]);
  });

  it("email_send to an AMBIGUOUS recipient → no send fires, logged `refused` (recipient resolved, never guessed)", async () => {
    const { fetchImpl, calls } = recordingFetchStatus();
    const file = logFile();
    const contacts: readonly Contact[] = [
      { id: "c1", name: "Bob", email: "bob1@example.com" },
      { id: "c2", name: "Bob", email: "bob2@example.com" },
    ];
    const result = await runActuatorByName("email_send", { body: "hi", subject: "Q3", to: "Bob" } as JsonObject, deps({ actionLogFile: file, contacts: () => contacts, fetchImpl, gmailToken: "gtok" }));
    expect(result.ran).toBe(false);
    expect(calls.some((u) => u.includes("/messages/send"))).toBe(false); // never guessed a recipient
    const log = await readActionLog(file);
    expect(log.map((e) => e.result)).toEqual(["refused"]);
    expect(log[0]?.detail).toContain("ambiguous");
  });
});
