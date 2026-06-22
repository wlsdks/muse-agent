import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHomeActionTool } from "./smart-home-tool.js";
import type { WebActionApprovalGate } from "./web-action.js";
import { readActionLog } from "@muse/stores";

function recordingFetch(): { fetchImpl: typeof fetch; calls: { url: string; body?: string }[] } {
  const calls: { url: string; body?: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
    calls.push({ body: init?.body, url: String(url) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const approve: WebActionApprovalGate = () => ({ approved: true });
const deny: WebActionApprovalGate = () => ({ approved: false, reason: "declined" });

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-home-tool-")), "action-log.json");
}

const ctx = { runId: "run-1", userId: "stark" };
function deps(gate: WebActionApprovalGate, fetchImpl: typeof fetch, actionLogFile = logFile()) {
  return { actionLogFile, approvalGate: gate, baseUrl: "http://ha.local:8123", fetchImpl, token: "tok", userId: "stark" };
}

describe("createHomeActionTool", () => {
  it("exposes an execute-risk home_action tool requiring service", () => {
    const { fetchImpl } = recordingFetch();
    const tool = createHomeActionTool(deps(approve, fetchImpl));
    expect(tool.definition.name).toBe("home_action");
    expect(tool.definition.risk).toBe("execute");
    expect(tool.definition.inputSchema.required).toEqual(["service"]);
  });

  it("CONFIRM: calls the HA service with the entity_id body, logged performed", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const actionLogFile = logFile();
    const tool = createHomeActionTool(deps(approve, fetchImpl, actionLogFile));
    const out = await tool.execute({ entity: "light.living_room", service: "light.turn_off" }, ctx);
    expect(out).toEqual({ performed: true, status: 200 });
    expect(calls[0]?.url).toBe("http://ha.local:8123/api/services/light/turn_off");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ entity_id: "light.living_room" });
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "performed" });
  });

  it("DENY: no service call fires", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const out = await createHomeActionTool(deps(deny, fetchImpl)).execute({ entity: "light.living_room", service: "light.turn_off" }, ctx);
    expect(out).toMatchObject({ performed: false, reason: "denied" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed service id (not domain.service) without firing", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const out = await createHomeActionTool(deps(approve, fetchImpl)).execute({ service: "turnoff" }, ctx) as Record<string, unknown>;
    expect(out.performed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("BLAST-RADIUS: refuses a service call with NO target (entity-less) BEFORE any HTTP — would hit every device in the domain", async () => {
    const { fetchImpl, calls } = recordingFetch();
    // `light.turn_off` with no entity/target is HA's "apply to EVERY light" path —
    // an easy 8B under-specification that would turn off the whole house.
    const out = await createHomeActionTool(deps(approve, fetchImpl)).execute({ service: "light.turn_off" }, ctx) as Record<string, unknown>;
    expect(out.performed).toBe(false);
    expect(String(out.reason)).toMatch(/target|entity|every device/i);
    expect(calls).toHaveLength(0); // no HTTP fired — the domain-wide call never leaves
  });

  it("BLAST-RADIUS: a scene/script activation (carries entity) still fires — the guard is selective", async () => {
    const { fetchImpl, calls } = recordingFetch();
    await createHomeActionTool(deps(approve, fetchImpl)).execute({ entity: "scene.movie_mode", service: "scene.turn_on" }, ctx);
    expect(calls).toHaveLength(1);
  });

  it("BLAST-RADIUS: a data-targeted call (area_id in data, no entity arg) still fires — a real broadcast target is allowed", async () => {
    const { fetchImpl, calls } = recordingFetch();
    await createHomeActionTool(deps(approve, fetchImpl)).execute({ data: { area_id: "kitchen" }, service: "light.turn_off" }, ctx);
    expect(calls).toHaveLength(1);
  });

  it("HA rejects the approved call (5xx) → the TOOL surfaces performed:false + reason/detail, logged failed", async () => {
    // The agent invokes this tool, not the shared helper — so the tools own
    // failure projection (outcome → { performed:false, reason, detail }) must
    // report the failure, never a false performed success, on a state-changing call.
    const fetchImpl = (async () => new Response("boom", { status: 502 })) as unknown as typeof fetch;
    const actionLogFile = logFile();
    const out = await createHomeActionTool(deps(approve, fetchImpl, actionLogFile))
      .execute({ entity: "lock.front_door", service: "lock.lock" }, ctx) as Record<string, unknown>;
    expect(out.performed).toBe(false);
    expect(out.reason).toBe("failed");
    expect(typeof out.detail).toBe("string");
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "failed" });
  });
});
