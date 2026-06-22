import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildHomeAssistantServiceCall, performHomeActionWithApproval } from "./smart-home.js";
import type { WebActionApprovalGate } from "./web-action.js";
import { readActionLog } from "@muse/stores";

function recordingFetch(): { fetchImpl: typeof fetch; calls: { url: string; method: string; body?: string; bearer: boolean }[] } {
  const calls: { url: string; method: string; body?: string; bearer: boolean }[] = [];
  const fetchImpl = (async (url: string | URL, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    calls.push({ bearer: (init?.headers?.authorization ?? "").startsWith("Bearer "), body: init?.body, method: init?.method ?? "GET", url: String(url) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const approve: WebActionApprovalGate = () => ({ approved: true });
const deny: WebActionApprovalGate = () => ({ approved: false, reason: "declined" });

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-home-")), "action-log.json");
}

const call = { baseUrl: "http://ha.local:8123/", domain: "light", entityId: "light.living_room", service: "turn_off", token: "ha-tok" };

describe("buildHomeAssistantServiceCall", () => {
  it("builds the HA service-call request with entity_id body + Bearer, trimming the base URL", () => {
    const { summary, request } = buildHomeAssistantServiceCall(call);
    expect(request.url).toBe("http://ha.local:8123/api/services/light/turn_off");
    expect(request.method).toBe("POST");
    expect(request.headers?.authorization).toBe("Bearer ha-tok");
    expect(JSON.parse(request.body ?? "{}")).toEqual({ entity_id: "light.living_room" });
    expect(summary).toBe("Home Assistant: light.turn_off (light.living_room)");
  });

  it("merges extra data into the body", () => {
    const { request } = buildHomeAssistantServiceCall({ ...call, data: { brightness: 120 } });
    expect(JSON.parse(request.body ?? "{}")).toEqual({ brightness: 120, entity_id: "light.living_room" });
  });
});

describe("performHomeActionWithApproval — gated", () => {
  it("CONFIRM: the HA service call fires once with the real shape, logged performed", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const actionLogFile = logFile();
    const outcome = await performHomeActionWithApproval({ ...call, actionLogFile, approvalGate: approve, fetchImpl, userId: "stark" });
    expect(outcome).toEqual({ performed: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ bearer: true, method: "POST", url: "http://ha.local:8123/api/services/light/turn_off" });
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ entity_id: "light.living_room" });
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "performed" });
  });

  it("DENY / absent approval: no HA call fires", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const outcome = await performHomeActionWithApproval({ ...call, actionLogFile: logFile(), approvalGate: deny, fetchImpl, userId: "stark" });
    expect(outcome).toMatchObject({ performed: false, reason: "denied" });
    expect(calls).toHaveLength(0);
  });
});
