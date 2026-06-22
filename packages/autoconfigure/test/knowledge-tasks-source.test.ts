import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFileTasksProvider } from "@muse/domain-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assembleKnowledgeCorpus, createNotesKnowledgeSearchTool } from "../src/knowledge-corpus.js";

const VOCAB = ["acme", "contract", "friday", "due", "renew"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

let dir: string;
let provider: LocalFileTasksProvider;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-ktasks-"));
  let n = 0;
  provider = new LocalFileTasksProvider({ file: join(dir, "tasks.json"), idFactory: () => `t${(++n).toString()}` });
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("assembleKnowledgeCorpus — tasks as a corpus source", () => {
  it("emits OPEN tasks as task/<id> chunks (title + notes), excluding done tasks", async () => {
    await provider.add({ notes: "The Acme contract is due Friday.", title: "Acme contract" }); // t1, open
    const done = await provider.add({ title: "Renew domain" }); // t2
    await provider.complete(done.id); // t2 → done

    const corpus = await assembleKnowledgeCorpus({ tasksProvider: provider });
    const bySource = new Map(corpus.map((chunk) => [chunk.source, chunk.text]));
    expect(bySource.get("task/Acme contract")).toContain("due Friday");
    expect(bySource.has("task/Renew domain")).toBe(false); // done task excluded
  });
});

describe("knowledge_search spans tasks — finds + cites a task fact", () => {
  it("answers a deadline query from the open task and cites task/<id>", async () => {
    await provider.add({ notes: "The Acme contract is due Friday.", title: "Acme contract" }); // t1
    const tool = createNotesKnowledgeSearchTool({ embed, tasksProvider: provider });
    const result = String(await tool.execute({ query: "when is the acme contract due?" }, { runId: "r1" }));
    expect(result).toContain("[task/Acme contract]");
    expect(result).toContain("due Friday");
  });
});
