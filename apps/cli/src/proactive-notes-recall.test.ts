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
