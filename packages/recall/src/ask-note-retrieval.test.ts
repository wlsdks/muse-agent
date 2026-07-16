import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { retrieveAndRankNotes } from "./ask-note-retrieval.js";
import type { FileEntry } from "./chunks.js";

let dir: string;

async function noteFile(name: string, text: string, embedding: number[]): Promise<FileEntry> {
  const path = join(dir, name);
  await writeFile(path, text);
  return { chunks: [{ chunkIndex: 0, embedding, file: path, text }], path };
}

const embedFn = async (): Promise<number[]> => [1, 0];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ask-note-retrieval-"));
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("retrieveAndRankNotes — stale-vs-current demotion (answer-evidence seam)", () => {
  it("bounds direct topK input to the CLI retrieval contract", async () => {
    const files = await Promise.all(Array.from({ length: 25 }, async (_value, index) =>
      noteFile(`note-${index.toString()}.md`, `note ${index.toString()}`, [1, 0])
    ));
    const result = await retrieveAndRankNotes({
      embedFn, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "notes", scope: undefined, topK: Number.POSITIVE_INFINITY
    });
    expect(result.scored).toEqual([]);

    const capped = await retrieveAndRankNotes({
      embedFn, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "notes", scope: undefined, topK: 999
    });
    expect(capped.preGapScored).toHaveLength(20);
  });

  // Both align closely with the query direction; the stale note's raw cosine
  // (1.0, a perfect match) OUTRANKS the current note's (~0.994) on score alone —
  // so a plain top-K cosine sort would rank the superseded fact first.
  it("ranks the CURRENT note above the higher-scoring but explicitly-stale one (top-1)", async () => {
    const stale = await noteFile("rent_old.md", "예전에 월세 120만원이었는데 지금은 아니다.", [1, 0]);
    const current = await noteFile("rent_new.md", "월세 125만원", [0.9, 0.1]);
    const result = await retrieveAndRankNotes({
      embedFn,
      embedModel: "test-embed",
      indexFiles: [stale, current],
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "what is my rent",
      scope: undefined,
      topK: 6
    });
    expect(result.scored[0]?.file).toBe(current.path);
    expect(result.scored.map((s) => s.file)).toEqual([current.path, stale.path]);
  });

  it("demotes, never drops — both notes still appear", async () => {
    const stale = await noteFile("rent_old.md", "예전에 월세 120만원이었는데 지금은 아니다.", [1, 0]);
    const current = await noteFile("rent_new.md", "월세 125만원", [0.9, 0.1]);
    const result = await retrieveAndRankNotes({
      embedFn,
      embedModel: "test-embed",
      indexFiles: [stale, current],
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "what is my rent",
      scope: undefined,
      topK: 6
    });
    expect(result.scored).toHaveLength(2);
  });

  it("leaves order untouched when neither note carries a stale marker (no behavior change for the common case)", async () => {
    const a = await noteFile("a.md", "월세 125만원", [1, 0]);
    const b = await noteFile("b.md", "wifi password is muse2026", [0.9, 0.1]);
    const result = await retrieveAndRankNotes({
      embedFn,
      embedModel: "test-embed",
      indexFiles: [a, b],
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "what is my rent",
      scope: undefined,
      topK: 6
    });
    expect(result.scored.map((s) => s.file)).toEqual([a.path, b.path]);
  });
});

describe("retrieveAndRankNotes — confident-gated 1-hop link expansion (the graph-hop seam)", () => {
  const unit = (x: number): number[] => [x, Math.sqrt(1 - x * x)];

  const linkedVault = async (): Promise<FileEntry[]> => [
    await noteFile("hub.md", "muse project hub [[low]] [[high]] [[mid]]", [1, 0]),
    await noteFile("low.md", "unrelated beta detail", unit(0.2)),
    await noteFile("high.md", "unrelated gamma detail", unit(0.6)),
    await noteFile("mid.md", "unrelated delta detail", unit(0.4))
  ];

  const ask = async (indexFiles: FileEntry[]) => retrieveAndRankNotes({
    embedFn,
    embedModel: "test-embed",
    indexFiles,
    json: true,
    notesDir: dir,
    onStderr: () => {},
    query: "muse project hub",
    scope: undefined,
    topK: 1
  });

  it("promotes linked notes by their REAL query cosine, not the [[link]] document order", async () => {
    const files = await linkedVault();
    const result = await ask(files);
    expect(result.scored.map((s) => s.file)).toEqual([
      files[0]!.path,       // the confident seed
      files[2]!.path,       // high.md (cosine 0.6) — promoted first
      files[3]!.path        // mid.md (cosine 0.4) — promoted second
    ]);
    expect(result.scored.map((s) => s.file)).not.toContain(files[1]!.path); // low.md loses the cap on cosine
  });

  it("promotes a note that BACKLINKS to the confident seed", async () => {
    const seed = await noteFile("topic.md", "muse project hub", [1, 0]);
    const citing = await noteFile("citing.md", "details citing [[topic]]", unit(0.5));
    const result = await ask([seed, citing]);
    expect(result.scored.map((s) => s.file)).toEqual([seed.path, citing.path]);
  });

  it("MUSE_RECALL_GRAPH_HOP=false disables expansion entirely (kill-switch parity with the second hop)", async () => {
    const files = await linkedVault();
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    try {
      const result = await ask(files);
      expect(result.scored.map((s) => s.file)).toEqual([files[0]!.path]);
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
    }
  });

  it("an ambiguous seed promotes a linked neighbor ONLY above the calibrated floor (bar 0.55 → floor 0.35 for test-embed)", async () => {
    // Isolate the graph hop: the second-hop augment legitimately fires on
    // ambiguous verdicts and would re-add the same note through a different door.
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const clearing = [
        await noteFile("hub.md", "muse project hub [[high]]", unit(0.3)),
        await noteFile("high.md", "unrelated gamma detail", unit(0.6))
      ];
      const promoted = await ask(clearing);
      expect(promoted.scored.map((s) => s.file)).toContain(clearing[1]!.path);

      const below = [
        await noteFile("hub2.md", "muse project hub [[weak]]", unit(0.3)),
        await noteFile("weak.md", "unrelated epsilon detail", unit(0.2))
      ];
      const rejected = await retrieveAndRankNotes({
        embedFn, embedModel: "test-embed", indexFiles: below, json: true, notesDir: dir,
        onStderr: () => {}, query: "muse project hub", scope: undefined, topK: 1
      });
      expect(rejected.scored.map((s) => s.file)).not.toContain(below[1]!.path);
    } finally {
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });
});

describe("retrieveAndRankNotes — local-LLM rerank seam (opt-in via rerankFn)", () => {
  const unit = (x: number): number[] => [x, Math.sqrt(1 - x * x)];

  const vault = async (): Promise<FileEntry[]> => [
    await noteFile("close.md", "rent thoughts rambling", unit(0.9)),
    await noteFile("answer.md", "autopay goes out on the 25th", unit(0.7)),
    await noteFile("noise.md", "wifi password muse2026", unit(0.5))
  ];

  const ask = async (indexFiles: FileEntry[], rerankFn?: (q: string, t: readonly string[]) => Promise<readonly number[] | undefined>) =>
    retrieveAndRankNotes({
      embedFn,
      embedModel: "test-embed",
      indexFiles,
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "rent transfer day",
      ...(rerankFn ? { rerankFn } : {}),
      scope: undefined,
      topK: 1
    });

  it("the reranker's pick replaces the cosine top-1 in the prompt window", async () => {
    const files = await vault();
    let sawTexts: readonly string[] = [];
    const result = await ask(files, async (_q, texts) => {
      sawTexts = texts;
      return [texts.findIndex((t) => t.includes("25th"))];
    });
    expect(sawTexts.length).toBeGreaterThan(1);
    expect(result.scored[0]?.file).toBe(files[1]!.path);
    expect(result.scored).toHaveLength(1);
  });

  it("a throwing or empty reranker fails open to the cosine ordering", async () => {
    const files = await vault();
    const thrown = await ask(files, async () => { throw new Error("model down"); });
    expect(thrown.scored[0]?.file).toBe(files[0]!.path);
    const empty = await ask(files, async () => undefined);
    expect(empty.scored[0]?.file).toBe(files[0]!.path);
  });

  it("out-of-range indices from the model are discarded, not crashed on", async () => {
    const files = await vault();
    const result = await ask(files, async () => [99, -3, 1]);
    expect(result.scored[0]?.file).toBe(files[1]!.path);
  });

  it("no rerankFn → unchanged single-topK behavior", async () => {
    const files = await vault();
    const result = await ask(files);
    expect(result.scored[0]?.file).toBe(files[0]!.path);
    expect(result.scored).toHaveLength(1);
  });
});
