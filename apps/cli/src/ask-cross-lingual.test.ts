import type { ActionLogEntry } from "@muse/mcp";
import { describe, expect, it, vi } from "vitest";

import { rescueActionsCrossLingual, rescueMemoryCrossLingual } from "./ask-cross-lingual.js";

// Deterministic "embedder": manager/매니저 → [1,0], dentist/치과 → [1,0], else [0,1].
const embedFn = vi.fn(async (t: string): Promise<readonly number[]> =>
  /매니저|manager|치과|dentist/u.test(t) ? [1, 0] : [0, 1]
);

const memory = { facts: { manager: "Dana Kim", project: "Apollo launch" }, preferences: {} };

describe("rescueMemoryCrossLingual", () => {
  it("rescues an EN fact for a KO query that scored lexical-0", async () => {
    const out = await rescueMemoryCrossLingual(memory, "매니저", new Set(["매니저"]), embedFn);
    expect(out.map((f) => f.key)).toEqual(["manager"]);
  });

  it("returns nothing for an empty store (no embed calls)", async () => {
    const calls = embedFn.mock.calls.length;
    const out = await rescueMemoryCrossLingual({ facts: {}, preferences: {} }, "매니저", new Set(["매니저"]), embedFn);
    expect(out).toEqual([]);
    expect(embedFn.mock.calls.length).toBe(calls); // speed guard: did not embed
  });
});

describe("rescueActionsCrossLingual", () => {
  const entries = [
    { what: "booked the dentist appointment", when: "2026-06-01T00:00:00Z" },
    { what: "renewed the gym membership", when: "2026-06-02T00:00:00Z" }
  ] as unknown as ActionLogEntry[];

  it("rescues an EN action for a KO query via cosine", async () => {
    const out = await rescueActionsCrossLingual(entries, "치과 예약", embedFn);
    expect(out.length).toBe(1);
    expect(out[0]!.what).toContain("dentist");
  });

  it("returns nothing for no entries", async () => {
    expect(await rescueActionsCrossLingual([], "치과", embedFn)).toEqual([]);
  });
});
