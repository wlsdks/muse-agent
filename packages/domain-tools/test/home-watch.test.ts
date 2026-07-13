import { describe, expect, it } from "vitest";

import { homeWatchesFromConfig } from "../src/index.js";
import { createWebWatchRunner, type ProactiveNoticeSink, type WebWatch } from "@muse/proactivity";

const noWait = { baseDelayMs: 0, sleep: async () => {} };

// Contract-faithful Home Assistant: GET /api/states/<id> → the HA body
// shape. Each call yields the next state in the sequence.
function haStateSequence(states: string[]) {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const state = states[Math.min(i++, states.length - 1)]!;
    const entityId = url.split("/api/states/")[1] ?? "x";
    return new Response(JSON.stringify({ attributes: {}, entity_id: entityId, state }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

describe("homeWatchesFromConfig — proactive home monitoring over HA entity state", () => {
  it("a door-unlocked watch fires once on the locked→unlocked edge, not while it stays unlocked", async () => {
    const { fetchImpl, calls } = haStateSequence(["locked", "unlocked", "unlocked"]);
    const watches = homeWatchesFromConfig(
      JSON.stringify([{ entityId: "lock.front_door", id: "door", message: "Front door is unlocked!", rule: { appears: "unlocked" }, title: "Front door" }]),
      { baseUrl: "http://ha.local", fetchImpl, retryOptions: noWait, token: "t" }
    );
    expect(watches).toHaveLength(1);

    const delivered: { title: string; text: string }[] = [];
    const sink: ProactiveNoticeSink = { deliver: (n) => { delivered.push(n); } };
    const runner = createWebWatchRunner({ sink, watches: watches as WebWatch[] });
    expect((await runner.tick()).delivered).toBe(0); // locked baseline
    expect((await runner.tick()).delivered).toBe(1); // unlocked → fire
    expect((await runner.tick()).delivered).toBe(0); // still unlocked → no re-fire
    expect(delivered[0]!.text).toContain("Front door is unlocked");
    expect(calls[0]).toBe("http://ha.local/api/states/lock.front_door");
  });

  it("a numeric above threshold fires when a sensor crosses it (freezer too warm)", async () => {
    const { fetchImpl } = haStateSequence(["-18", "-16", "-12"]);
    const watches = homeWatchesFromConfig(
      JSON.stringify([{ entityId: "sensor.freezer", id: "freezer", message: "Freezer is too warm!", rule: { above: -15 }, title: "Freezer" }]),
      { baseUrl: "http://ha.local", fetchImpl, retryOptions: noWait, token: "t" }
    );
    const delivered: unknown[] = [];
    const runner = createWebWatchRunner({ sink: { deliver: (n) => { delivered.push(n); } }, watches: watches as WebWatch[] });
    expect((await runner.tick()).delivered).toBe(0); // -18 baseline (below)
    expect((await runner.tick()).delivered).toBe(0); // -16 still below -15
    expect((await runner.tick()).delivered).toBe(1); // -12 → above -15 → fire
  });

  it("drops invalid entries (missing entityId / no rule condition) and non-array / malformed JSON", () => {
    const conn = { baseUrl: "http://ha.local", token: "t" };
    const watches = homeWatchesFromConfig(JSON.stringify([
      { entityId: "lock.ok", id: "ok", message: "m", rule: { appears: "unlocked" }, title: "t" },
      { id: "no-entity", message: "m", rule: { appears: "x" }, title: "t" },
      { entityId: "sensor.x", id: "no-cond", message: "m", rule: {}, title: "t" }
    ]), conn);
    expect(watches.map((w) => w.id)).toEqual(["ok"]);
    expect(homeWatchesFromConfig("{not json", conn)).toEqual([]);
    expect(homeWatchesFromConfig(JSON.stringify({ not: "array" }), conn)).toEqual([]);
  });

  it("a failed HA read skips the tick without losing the baseline (no false fire)", async () => {
    let i = 0;
    const fetchImpl = (async (url: string) => {
      i += 1;
      if (i === 2) return new Response("", { status: 503 }); // transient on the 2nd poll
      const entityId = url.split("/api/states/")[1] ?? "x";
      return new Response(JSON.stringify({ attributes: {}, entity_id: entityId, state: i === 1 ? "locked" : "locked" }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const watches = homeWatchesFromConfig(
      JSON.stringify([{ entityId: "lock.front_door", id: "door", message: "unlocked!", rule: { appears: "unlocked" }, title: "Door" }]),
      { baseUrl: "http://ha.local", fetchImpl, retryOptions: { baseDelayMs: 0, retries: 0, sleep: async () => {} }, token: "t" }
    );
    const delivered: unknown[] = [];
    const runner = createWebWatchRunner({ sink: { deliver: (n) => { delivered.push(n); } }, watches: watches as WebWatch[] });
    expect((await runner.tick()).delivered).toBe(0); // locked baseline
    expect((await runner.tick()).delivered).toBe(0); // 503 → snapshot undefined → skip, baseline kept
    expect(delivered).toHaveLength(0);
  });

  it("does not build a remote Home Assistant watch under local-only", () => {
    let fetched = false;
    let tokenReads = 0;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const connection = {
      baseUrl: "http://ha.local:8123",
      fetchImpl,
      localOnly: true
    } as Record<string, unknown>;
    Object.defineProperty(connection, "token", {
      configurable: true,
      get: () => {
        tokenReads += 1;
        throw new Error("remote watch token must not be read");
      }
    });
    const watches = homeWatchesFromConfig(
      JSON.stringify([{ entityId: "lock.front_door", id: "door", message: "unlocked!", rule: { appears: "unlocked" }, title: "Door" }]),
      connection as never
    );
    expect(watches).toEqual([]);
    expect(fetched).toBe(false);
    expect(tokenReads).toBe(0);
  });
});
