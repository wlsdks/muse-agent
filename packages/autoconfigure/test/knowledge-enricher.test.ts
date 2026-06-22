import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalDirNotesProvider } from "@muse/domain-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createKnowledgeEnricher } from "../src/knowledge-corpus.js";

const VOCAB = ["acme", "prep", "deck", "standup"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

let notesDir: string;
beforeEach(async () => {
  notesDir = await mkdtemp(join(tmpdir(), "muse-enrich-"));
  await writeFile(join(notesDir, "acme.md"), "Acme prep: bring the Q3 deck.", "utf8");
});
afterEach(async () => {
  await rm(notesDir, { force: true, recursive: true });
});

describe("createKnowledgeEnricher", () => {
  it("returns ONE compact [source] line for the best match on the imminent item's title", async () => {
    const enrich = createKnowledgeEnricher({ embed, notesProvider: new LocalDirNotesProvider({ notesDir }) });
    const line = await enrich("Acme strategy meeting");
    expect(line).toBe("[notes/acme.md] Acme prep: bring the Q3 deck.");
  });

  it("returns undefined when nothing is relevant (no sub-threshold fabrication)", async () => {
    const enrich = createKnowledgeEnricher({ embed, notesProvider: new LocalDirNotesProvider({ notesDir }) });
    expect(await enrich("weather forecast for tomorrow")).toBeUndefined();
  });

  it("returns undefined for an ambiguous (weak) match — CRAG confidence gate (2401.15884)", async () => {
    const enrich = createKnowledgeEnricher({ embed, notesProvider: new LocalDirNotesProvider({ notesDir }) });
    // "acme standup" shares only "acme" with the note → cosine ~0.41, above the
    // floor but below the confident bar → weak grounding, not surfaced as Related.
    expect(await enrich("acme standup")).toBeUndefined();
  });

  it("returns undefined for an empty query", async () => {
    const enrich = createKnowledgeEnricher({ embed, notesProvider: new LocalDirNotesProvider({ notesDir }) });
    expect(await enrich("   ")).toBeUndefined();
  });
});
