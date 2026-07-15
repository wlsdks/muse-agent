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

  it("does not expand from an ambiguous seed — confident-only gating is intact", async () => {
    const files = [
      await noteFile("hub.md", "muse project hub [[high]]", unit(0.3)),
      await noteFile("high.md", "unrelated gamma detail", unit(0.6))
    ];
    // Isolate the graph hop: the second-hop augment legitimately fires on
    // ambiguous verdicts and would re-add the same note through a different door.
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const result = await ask(files);
      expect(result.scored.map((s) => s.file)).not.toContain(files[1]!.path);
    } finally {
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });
});
