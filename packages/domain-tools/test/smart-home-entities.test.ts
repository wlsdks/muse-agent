import { describe, expect, it } from "vitest";

import { createHomeEntitiesTool, listHomeAssistantStates } from "../src/index.js";

const noWait = { baseDelayMs: 0, sleep: async () => {} };

function recordingFetch(responses: Array<{ status: number; body: string }>) {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

const STATES = JSON.stringify([
  { attributes: { friendly_name: "Front Door" }, entity_id: "lock.front_door", state: "locked" },
  { attributes: {}, entity_id: "light.living_room", state: "on" },
  { attributes: {}, entity_id: "sensor.temp", state: "21.4" },
  { not: "an entity" } // malformed element — skipped
]);

describe("listHomeAssistantStates — discover Home Assistant entities", () => {
  it("GETs /api/states with the Bearer token and parses the entity list (skipping malformed)", async () => {
    const { calls, fetchImpl } = recordingFetch([{ body: STATES, status: 200 }]);
    const entities = await listHomeAssistantStates({ baseUrl: "http://ha.local/", fetchImpl, token: "t" });
    expect(calls[0]).toBe("http://ha.local/api/states");
    expect(entities.map((e) => e.entityId)).toEqual(["lock.front_door", "light.living_room", "sensor.temp"]);
  });

  it("filters by domain prefix", async () => {
    const { fetchImpl } = recordingFetch([{ body: STATES, status: 200 }]);
    const lights = await listHomeAssistantStates({ baseUrl: "http://ha.local", domain: "light", fetchImpl, token: "t" });
    expect(lights.map((e) => e.entityId)).toEqual(["light.living_room"]);
  });

  it("recovers from a transient 503 by retrying (read is idempotent)", async () => {
    const { calls, fetchImpl } = recordingFetch([{ body: "", status: 503 }, { body: STATES, status: 200 }]);
    const entities = await listHomeAssistantStates({ baseUrl: "http://ha.local", fetchImpl, retryOptions: noWait, token: "t" });
    expect(entities.length).toBe(3);
    expect(calls).toHaveLength(2);
  });

  it("a permanent failure / malformed body → [] (never throws)", async () => {
    expect(await listHomeAssistantStates({ baseUrl: "http://ha.local", fetchImpl: recordingFetch([{ body: "nope", status: 500 }]).fetchImpl, retryOptions: noWait, token: "t" })).toEqual([]);
    expect(await listHomeAssistantStates({ baseUrl: "http://ha.local", fetchImpl: recordingFetch([{ body: "<html>", status: 200 }]).fetchImpl, token: "t" })).toEqual([]);
  });

  it("does not enumerate a remote Home Assistant endpoint under local-only", async () => {
    const { calls, fetchImpl } = recordingFetch([{ body: STATES, status: 200 }]);
    await expect(listHomeAssistantStates({ baseUrl: "http://ha.local", fetchImpl, localOnly: true, token: "t" })).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("createHomeEntitiesTool — read-only discovery tool", () => {
  it("is risk:read and returns the entity list", async () => {
    const { fetchImpl } = recordingFetch([{ body: STATES, status: 200 }]);
    const tool = createHomeEntitiesTool({ baseUrl: "http://ha.local", fetchImpl, token: "t" });
    expect(tool.definition.risk).toBe("read");
    const out = await tool.execute({ domain: "lock" }) as { count: number; entities: Array<{ entity: string }> };
    expect(out.count).toBe(1);
    expect(out.entities[0]!.entity).toBe("lock.front_door");
  });

  it("the `state` filter answers 'what's ON?' — returns only matching-state entities", async () => {
    const { fetchImpl } = recordingFetch([{ body: STATES, status: 200 }]);
    const out = await createHomeEntitiesTool({ baseUrl: "http://ha.local", fetchImpl, token: "t" })
      .execute({ state: "ON" }) as { count: number; entities: Array<{ entity: string; state: string }> };
    expect(out.count).toBe(1); // case-insensitive: "ON" matches "on"
    expect(out.entities[0]!.entity).toBe("light.living_room");
  });

  it("combines domain + state ('is the front door unlocked?' → none when it's locked)", async () => {
    const { fetchImpl } = recordingFetch([{ body: STATES, status: 200 }]);
    const tool = createHomeEntitiesTool({ baseUrl: "http://ha.local", fetchImpl, token: "t" });
    const locked = await tool.execute({ domain: "lock", state: "unlocked" }) as { count: number };
    expect(locked.count).toBe(0); // the only lock is "locked"
  });

  it("declares the `state` parameter", () => {
    const tool = createHomeEntitiesTool({ baseUrl: "http://ha.local", token: "t" });
    expect(tool.definition.inputSchema.properties).toHaveProperty("state");
  });
});
