import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildHomeAssistantServiceCall, performHomeActionWithApproval, resolveHomeAssistantTransportBaseUrl } from "./smart-home.js";
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

describe("Home Assistant local-only transport resolution", () => {
  it("permits only canonical root loopback endpoints and keeps the model /v1 contract out of HA", () => {
    expect(resolveHomeAssistantTransportBaseUrl("http://localhost:8123/", { localOnly: true }))
      .toEqual({ allowed: true, baseUrl: "http://127.0.0.1:8123" });
    for (const baseUrl of [
      "http://ha.local:8123",
      "http://192.168.1.9:8123",
      "https://localhost:8123",
      "http://localhost:8123/api",
      "http://localhost:8123/v1",
      "http://localhost:8123//",
      "http://localhost:8123/%2f"
    ]) {
      expect(resolveHomeAssistantTransportBaseUrl(baseUrl, { localOnly: true }), baseUrl)
        .toEqual({ allowed: false, reason: "Home Assistant remote paths are disabled while MUSE_LOCAL_ONLY=true; canonical loopback remains available" });
    }
  });

  it("preserves the normal-mode remote compatibility control", () => {
    expect(resolveHomeAssistantTransportBaseUrl("http://ha.local:8123/", { localOnly: false }))
      .toEqual({ allowed: true, baseUrl: "http://ha.local:8123/" });
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

  it("refuses a direct remote action under local-only before approval, request construction, or fetch", async () => {
    const { fetchImpl, calls } = recordingFetch();
    let approvals = 0;
    const outcome = await performHomeActionWithApproval({
      ...call,
      actionLogFile: logFile(),
      approvalGate: () => {
        approvals += 1;
        return { approved: true };
      },
      baseUrl: "http://ha.local:8123",
      fetchImpl,
      localOnly: true,
      userId: "stark"
    });
    expect(outcome).toMatchObject({
      performed: false,
      reason: "failed",
      detail: "Home Assistant remote paths are disabled while MUSE_LOCAL_ONLY=true; canonical loopback remains available"
    });
    expect(approvals).toBe(0);
    expect(calls).toEqual([]);
  });

  it("canonicalizes a local-only localhost action to numeric loopback", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const outcome = await performHomeActionWithApproval({
      ...call,
      actionLogFile: logFile(),
      approvalGate: approve,
      baseUrl: "http://localhost:8123/",
      fetchImpl,
      localOnly: true,
      userId: "stark"
    });
    expect(outcome).toEqual({ performed: true, status: 200 });
    expect(calls).toMatchObject([{ url: "http://127.0.0.1:8123/api/services/light/turn_off" }]);
  });
});
