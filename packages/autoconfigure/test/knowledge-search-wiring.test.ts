import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalDirNotesProvider } from "@muse/domain-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMuseRuntimeAssembly } from "../src/index.js";
import { createNotesKnowledgeSearchTool } from "../src/knowledge-corpus.js";

const VOCAB = ["allergic", "peanut", "shellfish"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

let notesDir: string;
beforeEach(async () => {
  notesDir = await mkdtemp(join(tmpdir(), "muse-ks-"));
  await writeFile(join(notesDir, "health.md"), "Jinan is allergic to peanuts and shellfish.", "utf8");
});
afterEach(async () => {
  await rm(notesDir, { force: true, recursive: true });
});

describe("createNotesKnowledgeSearchTool — lazy search over the live notes store", () => {
  it("assembles the corpus per call and returns the matching passage with its source", async () => {
    const tool = createNotesKnowledgeSearchTool({ embed, notesProvider: new LocalDirNotesProvider({ notesDir }) });
    const result = await tool.execute({ query: "what am I allergic to?" }, { runId: "r1" });
    expect(String(result)).toContain("[notes/health.md]");
    expect(String(result)).toContain("peanuts and shellfish");
  });

  it("picks up a note added AFTER the tool was built (fresh per call)", async () => {
    const tool = createNotesKnowledgeSearchTool({ embed, notesProvider: new LocalDirNotesProvider({ notesDir }) });
    await writeFile(join(notesDir, "more.md"), "Also allergic to peanut dust.", "utf8");
    const result = await tool.execute({ query: "allergic" }, { runId: "r2" });
    expect(String(result)).toContain("notes/more.md");
  });
});

describe("knowledge_search description — selectable for the breadth it actually spans", () => {
  it("names the news/feeds it now covers and drops the misleading 'live web data' steer", () => {
    const desc = createNotesKnowledgeSearchTool({ embed }).definition.description;
    // The corpus spans feeds (855) + email/calendar/etc — the description
    // must surface that so the local model selects it for "any news about X".
    expect(desc).toContain("feeds");
    expect(desc).toContain("news");
    expect(desc).not.toContain("live web data");
    // …while still keeping the genuine boundary against opening a new web page.
    expect(desc.toLowerCase()).toContain("web page");
  });
});

describe("createMuseRuntimeAssembly — knowledge_search reachability gating", () => {
  it("exposes knowledge_search in the tool registry when MUSE_KNOWLEDGE_SEARCH_ENABLED=true", () => {
    const assembly = createMuseRuntimeAssembly({ env: { MUSE_KNOWLEDGE_SEARCH_ENABLED: "true", MUSE_NOTES_DIR: notesDir } });
    expect(assembly.toolRegistry.get("knowledge_search")).toBeDefined();
  });

  it("does NOT expose knowledge_search by default (opt-in)", () => {
    const assembly = createMuseRuntimeAssembly({ env: { MUSE_NOTES_DIR: notesDir } });
    expect(assembly.toolRegistry.get("knowledge_search")).toBeUndefined();
  });
});
