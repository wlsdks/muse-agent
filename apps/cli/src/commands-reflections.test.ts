import { describe, expect, it } from "vitest";

import { reflectionsToStore, renderReflections } from "./commands-reflections.js";
import type { StoredReflection } from "@muse/mcp";

describe("renderReflections", () => {
  it("shows the empty state with a refresh hint", () => {
    expect(renderReflections([])).toContain("muse reflections refresh");
  });

  it("lists insights with their grounding sources, newest first", () => {
    const entries: StoredReflection[] = [
      { createdAtMs: 1_000, id: "a", insight: "You wrestle with home networking", sourceIds: ["ep-1", "ep-2"], supportCount: 2 },
      { createdAtMs: 3_000, id: "b", insight: "You prefer concise replies", sourceIds: ["ep-3", "ep-4"], supportCount: 2 }
    ];
    const out = renderReflections(entries);
    expect(out).toContain("You prefer concise replies"); // newest first
    expect(out.indexOf("concise")).toBeLessThan(out.indexOf("home networking"));
    expect(out).toContain("from ep-1, ep-2");
  });

  it("shows FOLLOWABLE sources (date + summary) when episodes are provided", () => {
    const entries: StoredReflection[] = [
      { createdAtMs: 1_000, id: "a", insight: "You wrestle with home networking", sourceIds: ["ep-1", "missing"], supportCount: 2 }
    ];
    const sources = new Map([["ep-1", { startedAt: "2026-05-10T09:00:00Z", summary: "Fixed the office VPN handshake by setting MTU 1380." }]]);
    const out = renderReflections(entries, sources);
    expect(out).toContain("[2026-05-10] Fixed the office VPN handshake");
    expect(out).toContain("· missing"); // unknown id falls back to the bare id
    expect(out).not.toContain("from ep-1"); // the bare-id format is replaced
  });
});

describe("reflectionsToStore", () => {
  it("stamps a clock + id and carries the grounding through", () => {
    let n = 0;
    const rows = reflectionsToStore(
      [{ insight: "X", sourceIds: ["e1", "e2"], supportCount: 2 }],
      5_000,
      () => `id-${(++n).toString()}`
    );
    expect(rows).toEqual([{ createdAtMs: 5_000, id: "id-1", insight: "X", sourceIds: ["e1", "e2"], supportCount: 2 }]);
  });
});

describe("shouldRunReflection — slow-cadence throttle", () => {
  it("runs when never run, and only after the interval elapses", async () => {
    const { shouldRunReflection } = await import("./commands-reflections.js");
    expect(shouldRunReflection(undefined, 1_000, 5_000)).toBe(true);
    expect(shouldRunReflection(1_000, 4_000, 5_000)).toBe(false); // 3s < 5s
    expect(shouldRunReflection(1_000, 6_000, 5_000)).toBe(true); // 5s elapsed
  });
});

describe("runReflectionPass", () => {
  it("synthesises + persists grounded reflections; <2 inputs is a no-op (no model call)", async () => {
    const { runReflectionPass } = await import("./commands-reflections.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "muse-rpass-"));
    const file = join(dir, "reflections.json");
    try {
      let calls = 0;
      const mp = { generate: async () => { calls += 1; return { output: '[{"insight":"You debug networking a lot","sources":["e1","e2","e3"]}]' }; } } as never;
      expect(await runReflectionPass([{ id: "e1", text: "x" }], { model: "m", modelProvider: mp, reflectionsFile: file })).toBe(0); // <2 → skip
      expect(calls).toBe(0);
      const added = await runReflectionPass(
        [{ id: "e1", text: "vpn" }, { id: "e2", text: "mtu" }, { id: "e3", text: "wireguard" }],
        { genId: () => "rid", model: "m", modelProvider: mp, now: () => 1, reflectionsFile: file }
      );
      expect(added).toBe(1);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
