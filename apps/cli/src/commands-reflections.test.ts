import { describe, expect, it } from "vitest";

import { reflectionsToStore, renderReflections, resolveReflectionsFile } from "./commands-reflections.js";
import type { StoredReflection } from "@muse/stores";

describe("resolveReflectionsFile", () => {
  it("honours MUSE_REFLECTIONS_FILE env override", () => {
    expect(resolveReflectionsFile({ MUSE_REFLECTIONS_FILE: "/tmp/r.json" })).toBe("/tmp/r.json");
  });

  it("defaults to ~/.muse/reflections.json when env key is absent", () => {
    expect(resolveReflectionsFile({}).endsWith("/.muse/reflections.json")).toBe(true);
  });
});

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
      // Two-phase: the synthesis call returns the reflection JSON; the RGV
      // re-verification judge (system = strict grounding judge) upholds it.
      const mp = {
        generate: async (req: { messages: readonly { content: string }[] }) => {
          calls += 1;
          const isJudge = req.messages.some((m) => m.content.includes("grounding judge"));
          return { output: isJudge ? "YES" : '[{"insight":"You debug networking a lot","sources":["e1","e2","e3"]}]' };
        }
      } as never;
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

  it("with embed: NOOP-drops a fresh insight that paraphrases an ALREADY-stored one (Mem0 cross-tick dedup)", async () => {
    const { runReflectionPass } = await import("./commands-reflections.js");
    const { addReflections, readReflections } = await import("@muse/stores");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "muse-rpass-noop-"));
    const file = join(dir, "reflections.json");
    try {
      // Pre-seed the store with a prior tick's insight.
      const STORED = "You debug networking a lot";
      const PARAPHRASE = "Networking issues take up much of your time"; // same theme, different words
      const DISTINCT = "You prefer terse replies";
      await addReflections(file, [{ createdAtMs: 1, id: "old", insight: STORED, sourceIds: ["e0"], supportCount: 2 }]);

      // This tick: the model re-dreams a PARAPHRASE of the stored insight + a DISTINCT one.
      const mp = {
        generate: async (req: { messages: readonly { content: string }[] }) => {
          const isJudge = req.messages.some((m) => m.content.includes("grounding judge"));
          return {
            output: isJudge
              ? "YES"
              : JSON.stringify([
                  { insight: PARAPHRASE, sources: ["e1", "e2"] },
                  { insight: DISTINCT, sources: ["e2", "e3"] }
                ])
          };
        }
      } as never;
      // Fake embedder: the paraphrase is near-identical to the stored insight;
      // the distinct insight is orthogonal. (Lexical dedup would MISS the paraphrase.)
      const embed = async (text: string): Promise<readonly number[]> => {
        if (text === STORED || text === PARAPHRASE) return [1, 0, 0];
        return [0, 1, 0];
      };
      const added = await runReflectionPass(
        [{ id: "e1", text: "vpn" }, { id: "e2", text: "mtu" }, { id: "e3", text: "terse" }],
        { genId: () => "rid", model: "m", modelProvider: mp, now: () => 2, reflectionsFile: file, embed }
      );
      expect(added).toBe(1); // only the DISTINCT insight is added; the paraphrase is NOOP-dropped
      const stored = await readReflections(file);
      expect(stored.map((r) => r.insight).sort()).toEqual([DISTINCT, STORED].sort());
      expect(stored.filter((r) => r.insight === PARAPHRASE)).toHaveLength(0);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
