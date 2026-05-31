import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildHomeAssistantServiceCall, performHomeActionWithApproval } from "../src/smart-home.js";

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
});
