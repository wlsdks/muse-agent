import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildHomeAssistantServiceCall, performHomeActionWithApproval } from "../src/smart-home.js";
import { createHomeActionTool } from "../src/smart-home-tool.js";

describe("buildHomeAssistantServiceCall", () => {
  it("builds the HA REST service-call request: URL, Bearer auth, entity_id + data body, summary", () => {
    const { request, summary } = buildHomeAssistantServiceCall({
      baseUrl: "http://ha.local/", // trailing slash must be stripped
      data: { brightness: 50 },
      domain: "light",
      entityId: "light.living_room",
      service: "turn_off",
      token: "TKN"
    });
    expect(request.url).toBe("http://ha.local/api/services/light/turn_off");
    expect(request.method).toBe("POST");
    expect((request.headers as Record<string, string>).authorization).toBe("Bearer TKN");
    expect(JSON.parse(request.body as string)).toEqual({ brightness: 50, entity_id: "light.living_room" });
    expect(summary).toBe("Home Assistant: light.turn_off (light.living_room)");
  });

  it("omits entity_id from the body and the summary when no entityId is given (e.g. a scene)", () => {
    const { request, summary } = buildHomeAssistantServiceCall({ baseUrl: "http://ha.local", domain: "scene", service: "turn_on", token: "T" });
    expect(JSON.parse(request.body as string)).toEqual({});
    expect(summary).toBe("Home Assistant: scene.turn_on");
  });
});

describe("performHomeActionWithApproval — draft-first / fail-closed (outbound-safety)", () => {
  let dir: string;
  let actionLogFile: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-ha-")); actionLogFile = join(dir, "actions.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  const base = (over: Record<string, unknown>) => ({
    actionLogFile,
    baseUrl: "http://ha.local",
    domain: "light",
    service: "turn_off",
    token: "T",
    userId: "u",
    ...over
  });

  it("POSTs the built HA request to the real fetch ONLY after approval", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => { calls.push(url); return new Response("", { status: 200 }); }) as unknown as typeof fetch;
    const outcome = await performHomeActionWithApproval(base({ approvalGate: () => ({ approved: true }), fetchImpl }) as never);
    expect(calls).toEqual(["http://ha.local/api/services/light/turn_off"]);
    expect(outcome).toMatchObject({ performed: true, status: 200 });
  });

  it("does NOT call fetch when approval is denied (no state change reaches the home)", async () => {
    let fetched = false;
    const fetchImpl = (async () => { fetched = true; return new Response(""); }) as unknown as typeof fetch;
    const outcome = await performHomeActionWithApproval(base({ approvalGate: () => ({ approved: false, reason: "user declined" }), fetchImpl }) as never);
    expect(fetched).toBe(false);
    expect(outcome).toMatchObject({ performed: false });
  });

  it("SURVIVES a 429 rate-limit: the idempotent HA call_service retries (honouring Retry-After) and performs, approving ONCE", async () => {
    let i = 0;
    let approvals = 0;
    const slept: number[] = [];
    const fetchImpl = (async () => {
      const status = i === 0 ? 429 : 200;
      i += 1;
      return new Response("", { status, ...(status === 429 ? { headers: { "retry-after": "1" } } : {}) });
    }) as unknown as typeof fetch;
    const outcome = await performHomeActionWithApproval(base({
      approvalGate: () => { approvals += 1; return { approved: true }; },
      fetchImpl,
      sleep: async (ms: number) => { slept.push(ms); }
    }) as never);
    expect(outcome).toMatchObject({ performed: true, status: 200 });
    expect(i).toBe(2); // one 429 + one success — the home actuator opted into the safe retry
    expect(approvals).toBe(1); // re-transmit only, never re-approve
    expect(slept).toEqual([1000]);
  });

  it("does NOT retry a 5xx on the home action (ambiguous — a toggle/script may have run): single attempt", async () => {
    let i = 0;
    const fetchImpl = (async () => { i += 1; return new Response("", { status: 503 }); }) as unknown as typeof fetch;
    const outcome = await performHomeActionWithApproval(base({ approvalGate: () => ({ approved: true }), fetchImpl, sleep: async () => {} }) as never);
    expect(outcome).toMatchObject({ performed: false, reason: "failed" });
    expect(i).toBe(1);
  });
});

describe("createHomeActionTool — fail-closed: a call with no CONCRETE target makes NO service call (no whole-domain blast)", () => {
  // The approval gate APPROVES and the fetch spy records every call. If the guard
  // is bypassed, the approved action reaches fetch and a service call escapes —
  // which for a no-target 'light.turn_off' is Home Assistant's whole-domain path.
  const spyTool = () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const tool = createHomeActionTool({
      actionLogFile: "/tmp/muse-ha-should-not-write.json",
      approvalGate: () => ({ approved: true }), // confirmed — so ONLY the guard can stop the call
      baseUrl: "http://ha.local",
      fetchImpl,
      token: "T",
      userId: "u"
    });
    return { calls, tool };
  };

  it("refuses 'light.turn_off' with no entity and no data target — never reaches fetch", async () => {
    const { calls, tool } = spyTool();
    const r = (await tool.execute({ service: "light.turn_off" })) as Record<string, unknown>;
    expect(r).toMatchObject({ performed: false });
    expect(String(r["reason"])).toContain("target");
    expect(calls).toEqual([]); // no service call escaped
  });

  it("an EMPTY/blank data target must NOT bypass the fail-close — still no service call", async () => {
    for (const data of [{ target: {} }, { entity_id: [] }, { entity_id: "" }, { target: { entity_id: [] } }] as const) {
      const { calls, tool } = spyTool();
      const r = (await tool.execute({ data, service: "light.turn_off" })) as Record<string, unknown>;
      expect(r, `data=${JSON.stringify(data)} must be refused`).toMatchObject({ performed: false });
      expect(calls, `data=${JSON.stringify(data)} must make NO service call (empty target is no target)`).toEqual([]);
    }
  });

  it("a CONCRETE entity gets past the guard (reaches the approved fetch)", async () => {
    const { calls, tool } = spyTool();
    const r = (await tool.execute({ entity: "light.living_room", service: "light.turn_off" })) as Record<string, unknown>;
    expect(r).toMatchObject({ performed: true });
    expect(calls).toEqual(["http://ha.local/api/services/light/turn_off"]);
  });
});
