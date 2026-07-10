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
