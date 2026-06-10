import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyRetrievalConfidence } from "@muse/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { councilCorpusMatches, defaultEmbedModel, isCouncilGroundedMode } from "./council-corpus.js";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "council-corpus-")); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

// A fake embedder: the query embeds to the "VPN" axis; chunk embeddings are set
// so the VPN note is near (confident) and the recipe note is far.
const AXIS: Record<string, readonly number[]> = {
  vpn: [1, 0, 0],
  recipe: [0, 1, 0]
};
const fakeEmbed = (text: string): Promise<readonly number[]> =>
  Promise.resolve(/vpn|mtu|network/iu.test(text) ? AXIS.vpn! : AXIS.recipe!);

async function writeIndex(noteFiles: { path: string; text: string; embedding: readonly number[] }[]): Promise<string> {
  for (const f of noteFiles) await writeFile(f.path, f.text, "utf8");
  const index = { files: noteFiles.map((f) => ({ chunks: [{ embedding: f.embedding, text: f.text }], path: f.path })), model: "nomic-embed-text" };
  const indexFile = join(dir, "notes-index.json");
  await writeFile(indexFile, JSON.stringify(index), "utf8");
  return indexFile;
}

describe("councilCorpusMatches — local corpus retrieval for self-abstention", () => {
  it("returns [] (⇒ abstain) when there is no notes index", async () => {
    const env = { MUSE_NOTES_INDEX_FILE: join(dir, "absent.json") };
    expect(await councilCorpusMatches("anything", { embedFn: fakeEmbed, env })).toEqual([]);
  });

  it("ranks the member's own chunks by absolute cosine; a confident match makes it speak", async () => {
    const vpnNote = join(dir, "vpn.md");
    const recipeNote = join(dir, "recipe.md");
    const indexFile = await writeIndex([
      { embedding: AXIS.vpn!, path: vpnNote, text: "The office VPN uses MTU 1380" },
      { embedding: AXIS.recipe!, path: recipeNote, text: "Carbonara needs guanciale" }
    ]);
    const env = { MUSE_NOTES_INDEX_FILE: indexFile };
    const matches = await councilCorpusMatches("what MTU for the VPN?", { embedFn: fakeEmbed, env });
    expect(matches[0]!.source).toBe(vpnNote);
    expect(matches[0]!.cosine).toBeCloseTo(1, 5);
    // The VPN question confidently grounds → the member would speak.
    expect(classifyRetrievalConfidence(matches)).toBe("confident");
  });

  it("an off-corpus question yields no confident match → the member abstains", async () => {
    const recipeNote = join(dir, "recipe.md");
    const indexFile = await writeIndex([
      { embedding: AXIS.recipe!, path: recipeNote, text: "Carbonara needs guanciale" }
    ]);
    const env = { MUSE_NOTES_INDEX_FILE: indexFile };
    // The query is on the VPN axis; the only note is on the recipe axis → cosine 0.
    const matches = await councilCorpusMatches("what MTU for the VPN?", { embedFn: fakeEmbed, env });
    expect(classifyRetrievalConfidence(matches)).not.toBe("confident");
  });

  it("fails closed to [] when the embedder throws (corpus unreachable ⇒ abstain, never guess)", async () => {
    const note = join(dir, "n.md");
    const indexFile = await writeIndex([{ embedding: AXIS.vpn!, path: note, text: "x" }]);
    const env = { MUSE_NOTES_INDEX_FILE: indexFile };
    const throwing = (): Promise<readonly number[]> => Promise.reject(new Error("ollama down"));
    expect(await councilCorpusMatches("q", { embedFn: throwing, env })).toEqual([]);
  });

  it("isCouncilGroundedMode parses the opt-in env; defaultEmbedModel falls back to the shipped default", () => {
    expect(isCouncilGroundedMode({ MUSE_A2A_COUNCIL_GROUNDED: "true" })).toBe(true);
    expect(isCouncilGroundedMode({ MUSE_A2A_COUNCIL_GROUNDED: "ON" })).toBe(true);
    expect(isCouncilGroundedMode({})).toBe(false);
    expect(isCouncilGroundedMode({ MUSE_A2A_COUNCIL_GROUNDED: "false" })).toBe(false);
    expect(defaultEmbedModel({})).toBe("nomic-embed-text-v2-moe");
    expect(defaultEmbedModel({ MUSE_EMBED_MODEL: "custom-embed" })).toBe("custom-embed");
  });
});
