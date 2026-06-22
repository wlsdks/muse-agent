import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalDirNotesProvider } from "@muse/domain-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assembleKnowledgeCorpus, createNotesKnowledgeSearchTool } from "../src/knowledge-corpus.js";

const VOCAB = ["allergic", "peanut", "shellfish", "filler"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

// The allergy fact lives in the SECOND paragraph — past the first 60
// chars, so the old truncate would have dropped it entirely.
const FILLER = "This filler paragraph is about the filler project roadmap.";
const FACT = "Jinan is allergic to peanuts and shellfish.";

let notesDir: string;
beforeEach(async () => {
  notesDir = await mkdtemp(join(tmpdir(), "muse-chunk-"));
  await writeFile(join(notesDir, "long.md"), `${FILLER}\n\n${FACT}`, "utf8");
});
afterEach(async () => {
  await rm(notesDir, { force: true, recursive: true });
});

describe("assembleKnowledgeCorpus — long notes are chunked, not truncated", () => {
  it("emits one chunk per passage, each labelled notes/<id>#n", async () => {
    const corpus = await assembleKnowledgeCorpus({ maxCharsPerNote: 60, notesProvider: new LocalDirNotesProvider({ notesDir }) });
    const sources = corpus.map((chunk) => chunk.source);
    expect(sources).toEqual(["notes/long.md#1", "notes/long.md#2"]);
    // The fact is preserved in chunk 2 (the old truncate dropped it).
    expect(corpus[1]!.text).toContain("peanuts and shellfish");
  });
});

describe("P20 knowledge — RAG retrieves + cites the relevant PASSAGE of a long note", () => {
  it("answers from the later chunk and cites notes/long.md#2", async () => {
    const tool = createNotesKnowledgeSearchTool({
      embed,
      maxCharsPerNote: 60,
      notesProvider: new LocalDirNotesProvider({ notesDir })
    });
    const result = String(await tool.execute({ query: "what am I allergic to?" }, { runId: "r1" }));
    expect(result).toContain("[notes/long.md#2]");
    expect(result).toContain("peanuts and shellfish");
    // The unrelated filler passage is not surfaced.
    expect(result).not.toContain("filler project roadmap");
  });
});
