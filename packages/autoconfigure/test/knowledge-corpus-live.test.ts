import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime, createKnowledgeSearchTool } from "@muse/agent-core";
import { LocalDirNotesProvider } from "@muse/domain-tools";
import type { ModelProvider } from "@muse/model";
import { ToolRegistry } from "@muse/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assembleKnowledgeCorpus } from "../src/knowledge-corpus.js";

const VOCAB = ["allergic", "peanut", "shellfish", "insurance", "policy", "muse", "project", "weekly"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

let notesDir: string;

beforeEach(async () => {
  notesDir = await mkdtemp(join(tmpdir(), "muse-knowledge-"));
  await writeFile(join(notesDir, "health.md"), "Jinan is allergic to peanuts and shellfish.", "utf8");
  await writeFile(join(notesDir, "projects.md"), "The Muse project ships weekly.", "utf8");
  await writeFile(join(notesDir, "photo.png"), "binary-not-a-note", "utf8");
});

afterEach(async () => {
  await rm(notesDir, { force: true, recursive: true });
});

describe("assembleKnowledgeCorpus — over the LIVE LocalDirNotesProvider", () => {
  it("reads every real note into a sourced chunk and merges ingested-doc chunks", async () => {
    const provider = new LocalDirNotesProvider({ notesDir });
    const corpus = await assembleKnowledgeCorpus({
      extraChunks: [{ source: "docs/insurance.pdf", text: "The home insurance policy number is HOME-99812." }],
      notesProvider: provider
    });

    const bySource = new Map(corpus.map((chunk) => [chunk.source, chunk.text]));
    expect(bySource.get("notes/health.md")).toContain("peanuts and shellfish");
    expect(bySource.get("notes/projects.md")).toContain("Muse project");
    expect(bySource.get("docs/insurance.pdf")).toContain("HOME-99812");
    // The non-note file is not in the corpus.
    expect([...bySource.keys()].some((source) => source.includes("photo.png"))).toBe(false);
  });

  it("honours maxNotes", async () => {
    const provider = new LocalDirNotesProvider({ notesDir });
    const corpus = await assembleKnowledgeCorpus({ maxNotes: 1, notesProvider: provider });
    expect(corpus).toHaveLength(1);
  });

  it("returns [] with no sources", async () => {
    expect(await assembleKnowledgeCorpus({})).toEqual([]);
  });
});

function citingProvider(query: string): ModelProvider {
  let turn = 0;
  return {
    id: "fake",
    async generate(request) {
      turn += 1;
      if (turn === 1) {
        return {
          id: "t1",
          model: request.model,
          output: "Checking your notes.",
          toolCalls: [{ arguments: { query }, id: "tc-1", name: "knowledge_search" }]
        };
      }
      const toolMessage = [...request.messages].reverse().find((message) => message.role === "tool");
      return { id: "t2", model: request.model, output: `From your records — ${toolMessage?.content ?? "(none)"}` };
    },
    async listModels() {
      return [];
    },
    async *stream() {
      /* unused */
    }
  };
}

describe("P20 knowledge slice 2 — the agent answers from the user's LIVE notes and cites the real source", () => {
  it("retrieves from the live notes corpus and grounds + attributes the answer", async () => {
    const provider = new LocalDirNotesProvider({ notesDir });
    const corpus = await assembleKnowledgeCorpus({
      extraChunks: [{ source: "docs/insurance.pdf", text: "The home insurance policy number is HOME-99812." }],
      notesProvider: provider
    });

    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: citingProvider("what am I allergic to?"),
      toolRegistry: new ToolRegistry([createKnowledgeSearchTool({ corpus, embed })])
    });

    const result = await runtime.run({
      messages: [{ content: "Search my notes — what am I allergic to?", role: "user" }],
      model: "provider/model",
      runId: "p20-knowledge-live"
    });

    expect(result.toolsUsed).toContain("knowledge_search");
    expect(result.response.output).toContain("peanuts and shellfish");
    expect(result.response.output).toContain("notes/health.md");
    expect(result.response.output).not.toContain("insurance.pdf");
  });
});
