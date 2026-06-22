import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime, createKnowledgeSearchTool } from "@muse/agent-core";
import { runAmbientNoticeTick, type AmbientNoticeRule, type ProactiveNoticeSink } from "@muse/proactivity";
import { LocalDirNotesProvider } from "@muse/domain-tools";
import type { ModelProvider } from "@muse/model";
import { ToolRegistry } from "@muse/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assembleKnowledgeCorpus } from "../src/knowledge-corpus.js";

/**
 * P20 target-completion audit (the P→P seam check). P20's two bullets
 * — Knowledge (multi-doc RAG with citation, 754/755) and Perception
 * (ambient signal → proactive notice, 756) — deepen the two thin
 * axes. They are independent capabilities; this proves BOTH deliver
 * their user flow in one realistic assistant setup, without
 * interference — a daily driver that answers from your notes AND
 * notices your context unasked.
 */

const VOCAB = ["allergic", "peanut", "shellfish"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

let notesDir: string;
beforeEach(async () => {
  notesDir = await mkdtemp(join(tmpdir(), "muse-p20-"));
  await writeFile(join(notesDir, "health.md"), "Jinan is allergic to peanuts and shellfish.", "utf8");
});
afterEach(async () => {
  await rm(notesDir, { force: true, recursive: true });
});

function knowledgeProvider(query: string): ModelProvider {
  let turn = 0;
  return {
    id: "fake",
    async generate(request) {
      turn += 1;
      if (turn === 1) {
        return { id: "t1", model: request.model, output: "Checking notes.", toolCalls: [{ arguments: { query }, id: "c1", name: "knowledge_search" }] };
      }
      const toolMessage = [...request.messages].reverse().find((message) => message.role === "tool");
      return { id: "t2", model: request.model, output: `From your records — ${toolMessage?.content ?? "(none)"}` };
    },
    async listModels() { return []; },
    async *stream() { /* unused */ }
  };
}

describe("P20 audit — knowledge grounding + ambient perception both deliver in one setup", () => {
  it("answers from the live notes corpus (cited) AND fires a proactive ambient notice", async () => {
    // Knowledge bullet: RAG over the user's live notes, with citation.
    const corpus = await assembleKnowledgeCorpus({ notesProvider: new LocalDirNotesProvider({ notesDir }) });
    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: knowledgeProvider("what am I allergic to?"),
      toolRegistry: new ToolRegistry([createKnowledgeSearchTool({ corpus, embed })])
    });
    const answer = await runtime.run({
      messages: [{ content: "Search my notes — what am I allergic to?", role: "user" }],
      model: "provider/model",
      runId: "p20-seam-knowledge"
    });
    expect(answer.response.output).toContain("peanuts and shellfish");
    expect(answer.response.output).toContain("notes/health.md");

    // Perception bullet: an ambient signal drives a proactive notice, no invoke.
    const delivered: { text: string; title: string; kind: string }[] = [];
    const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
    const rule: AmbientNoticeRule = { id: "standup", match: { window: "standup" }, message: "Standup at 14:00 — open your notes.", title: "Standup" };
    const summary = await runAmbientNoticeTick({
      rules: [rule],
      sink,
      source: { snapshot: () => ({ app: "Calendar", window: "Team Standup — 14:00" }) }
    });
    expect(summary.delivered).toBe(1);
    expect(delivered[0]!.text).toContain("Standup at 14:00");
  });
});
