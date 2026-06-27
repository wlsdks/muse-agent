import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FindingResurfaceSuppressor } from "@muse/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createIndexedProactiveInvestigator,
  proactiveMatchesFromIndex
} from "./proactive-notes-recall.js";

describe("proactiveMatchesFromIndex", () => {
  const chunks = [
    { embedding: [1, 0, 0], file: "a.md", text: "alpha" },
    { embedding: [0, 1, 0], file: "b.md", text: "beta" },
    { embedding: [0.9, 0.1, 0], file: "c.md", text: "near-alpha" }
  ];

  it("ranks by cosine to the query vector, top-K descending", () => {
    const out = proactiveMatchesFromIndex([1, 0, 0], chunks, 2);
    expect(out).toHaveLength(2);
    expect(out[0]!.source).toBe("a.md");
    expect(out[1]!.source).toBe("c.md");
    expect(out[0]!.cosine).toBeGreaterThan(out[1]!.cosine!);
  });

  it("tags an untrusted note's match trusted:false via the predicate (NP-proactive) and leaves others trusted", () => {
    const out = proactiveMatchesFromIndex([1, 0, 0], chunks, 3, (file) => file === "a.md");
    expect(out.find((m) => m.source === "a.md")?.trusted).toBe(false);
    expect(out.find((m) => m.source === "c.md")?.trusted).toBeUndefined();
  });

  it("no predicate → no match is tagged (no over-marking)", () => {
    const out = proactiveMatchesFromIndex([1, 0, 0], chunks, 3);
    expect(out.every((m) => m.trusted === undefined)).toBe(true);
  });
});

describe("createIndexedProactiveInvestigator", () => {
  let dir: string;
  let indexFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-pnr-"));
    indexFile = join(dir, "notes-index.json");
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const writeIndex = async () => {
    await writeFile(indexFile, JSON.stringify({
      files: [{ chunks: [
        { embedding: [1, 0, 0], file: "q3.md", text: "Q3 budget review prep: bring the forecast." },
        { embedding: [0, 1, 0], file: "cat.md", text: "Cat vaccination next spring." }
      ] }],
      model: "fake",
      version: 1
    }), "utf8");
  };

  it("surfaces a cited finding when the query embeds close to a chunk (confident)", async () => {
    await writeIndex();
    const investigate = createIndexedProactiveInvestigator({
      embedText: async () => [1, 0, 0], // aligns with q3.md → cosine 1.0
      indexFile
    });
    const finding = await investigate({ factSheet: "", kind: "task", title: "Q3 budget review" });
    expect(finding).toContain("[q3.md]");
    expect(finding).toContain("Q3 budget review prep");
  });

  it("stays silent when the query is far from every chunk (ambiguous/none)", async () => {
    await writeIndex();
    const investigate = createIndexedProactiveInvestigator({
      embedText: async () => [0, 0, 1], // orthogonal to both → cosine 0
      indexFile
    });
    expect(await investigate({ factSheet: "", kind: "task", title: "Anything" })).toBeUndefined();
  });

  // The bar is EMBEDDER-AWARE: on the shipped default (v2-moe) a genuine match tops
  // out ~0.42–0.46, so the nomic-calibrated 0.55 would leave the proactive surface
  // dead. Default to the v2-moe-calibrated 0.45 so the surface actually fires.
  const writeV2Index = async () => {
    await writeFile(indexFile, JSON.stringify({
      files: [{ chunks: [
        { embedding: [1, 0, 0], file: "q3.md", text: "Q3 budget review prep: bring the forecast." },
        { embedding: [0, 1, 0], file: "cat.md", text: "Cat vaccination next spring." }
      ] }],
      model: "nomic-embed-text-v2-moe",
      version: 1
    }), "utf8");
  };

  it("v2-moe: surfaces a genuine sub-0.55 match (cosine 0.46) the nomic 0.55 bar would have left dead", async () => {
    await writeV2Index();
    const investigate = createIndexedProactiveInvestigator({
      embedText: async () => [0.46, 0, 0.8879], // cosine 0.46 to q3.md, 0 to cat.md
      indexFile
    });
    expect(await investigate({ factSheet: "", kind: "task", title: "Q3 budget review" })).toContain("[q3.md]");
  });

  it("v2-moe: an explicit stricter confidentAt (0.55) still holds the 0.46 match silent (override wins)", async () => {
    await writeV2Index();
    const investigate = createIndexedProactiveInvestigator({
      confidentAt: 0.55,
      embedText: async () => [0.46, 0, 0.8879],
      indexFile
    });
    expect(await investigate({ factSheet: "", kind: "task", title: "Q3 budget review" })).toBeUndefined();
  });

  it("v2-moe: an absent-like match below the 0.45 floor (cosine 0.40) stays silent — fabrication-safe", async () => {
    await writeV2Index();
    const investigate = createIndexedProactiveInvestigator({
      embedText: async () => [0.40, 0, 0.9165], // cosine 0.40 to q3.md → below the v2-moe floor
      indexFile
    });
    expect(await investigate({ factSheet: "", kind: "task", title: "Q3 budget review" })).toBeUndefined();
  });

  it("anti-nag: the SAME finding for a recurring item is suppressed within the cooldown, re-shown after (arXiv:2410.12361)", async () => {
    await writeIndex();
    let clock = 1_000_000;
    const cooldownMs = 6 * 60 * 60 * 1_000;
    const investigate = createIndexedProactiveInvestigator({
      embedText: async () => [1, 0, 0], // confident match → same q3.md finding each call
      indexFile,
      suppressor: new FindingResurfaceSuppressor(cooldownMs),
      now: () => clock
    });
    const item = { factSheet: "", kind: "task" as const, title: "Q3 budget review" };
    const first = await investigate(item);
    expect(first).toContain("[q3.md]"); // call 1 surfaces
    clock += 60_000; // 1 min later, same recurring item re-fires
    expect(await investigate(item)).toBeUndefined(); // suppressed (identical finding within cooldown)
    clock += cooldownMs; // cooldown elapsed
    expect(await investigate(item)).toContain("[q3.md]"); // re-shown — reversible, not a permanent mute
  });

  it("fail-open: missing index file / empty title / throwing embed → undefined", async () => {
    const missing = createIndexedProactiveInvestigator({ embedText: async () => [1, 0, 0], indexFile: join(dir, "nope.json") });
    expect(await missing({ factSheet: "", kind: "task", title: "x" })).toBeUndefined();
    await writeIndex();
    const blankTitle = createIndexedProactiveInvestigator({ embedText: async () => [1, 0, 0], indexFile });
    expect(await blankTitle({ factSheet: "", kind: "task", title: "   " })).toBeUndefined();
    const boom = createIndexedProactiveInvestigator({ embedText: async () => { throw new Error("ollama down"); }, indexFile });
    expect(await boom({ factSheet: "", kind: "task", title: "Q3" })).toBeUndefined();
  });
});
