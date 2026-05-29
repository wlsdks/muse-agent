import type { AgentSpec, AgentSpecResolution } from "@muse/agent-specs";
import { COMPACTION_SUMMARY_PREFIX, type ConversationSummary, type ConversationSummaryStore } from "@muse/memory";
import { describe, expect, it } from "vitest";

import { applyAgentSpec, applyStoredConversationSummary } from "../src/context-transforms.js";
import type { AgentRunContext, AgentRunInput, AgentSpecResolver } from "../src/types.js";

const messages = [{ role: "user" as const, content: "help with billing" }];
const input = (metadata: Record<string, unknown> = {}): AgentRunInput => ({ model: "m", messages, metadata });
const context = (msgs = messages, metadata: Record<string, unknown> = {}): AgentRunContext => ({
  runId: "r",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: msgs, metadata },
});

const spec: AgentSpec = {
  id: "s1",
  name: "Biller",
  description: "billing helper",
  toolNames: ["pay"],
  keywords: ["billing"],
  mode: "standard",
  enabled: true,
  independentExecution: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};
const resolver = (impl: () => Promise<AgentSpecResolution | undefined>): AgentSpecResolver => ({ resolve: impl });

describe("applyAgentSpec", () => {
  it("passes the input through untouched when no resolver is configured", async () => {
    const original = input();
    const result = await applyAgentSpec(original, undefined);
    expect(result.agentSpec).toBeUndefined();
    expect(result.input).toBe(original);
  });

  it("attaches the resolution and stamps its confidence / keywords / tools on metadata", async () => {
    const result = await applyAgentSpec(input(), resolver(async () => ({ spec, confidence: 0.8, matchedKeywords: ["billing"] })));
    expect(result.agentSpec?.spec.name).toBe("Biller");
    expect(result.input.metadata).toMatchObject({
      agentSpecConfidence: 0.8,
      agentSpecMatchedKeywords: ["billing"],
      agentSpecName: "Biller",
      agentSpecResolutionAttempted: true,
      agentSpecToolNames: ["pay"],
    });
  });

  it("records the attempt (no failure flag) when the resolver finds nothing", async () => {
    const result = await applyAgentSpec(input(), resolver(async () => undefined));
    expect(result.agentSpec).toBeUndefined();
    expect(result.input.metadata).toEqual({ agentSpecResolutionAttempted: true });
  });

  it("fails open and flags the failure when the resolver throws", async () => {
    const result = await applyAgentSpec(input(), resolver(async () => { throw new Error("boom"); }));
    expect(result.agentSpec).toBeUndefined();
    expect(result.input.metadata).toMatchObject({ agentSpecResolutionAttempted: true, agentSpecResolutionFailed: true });
  });
});

describe("applyStoredConversationSummary", () => {
  const store = (summary: ConversationSummary | undefined, onGet?: () => never): ConversationSummaryStore => ({
    get: async () => {
      if (onGet) onGet();
      return summary;
    },
    save: async () => undefined,
  });
  const summary = (narrative: string): ConversationSummary => ({ narrative, sessionId: "sess-1", summarizedUpToIndex: 2 });

  it("leaves the messages untouched without a store, without a sessionId, or on an empty narrative", async () => {
    expect((await applyStoredConversationSummary(context(messages, { sessionId: "sess-1" }), undefined)).messages).toHaveLength(1);
    expect((await applyStoredConversationSummary(context(messages, {}), store(summary("n")))).messages).toHaveLength(1);
    expect((await applyStoredConversationSummary(context(messages, { sessionId: "sess-1" }), store(summary("   ")))).messages).toHaveLength(1);
  });

  it("prepends the stored summary as a compaction-prefixed system message", async () => {
    const result = await applyStoredConversationSummary(context(messages, { sessionId: "sess-1" }), store(summary("prior chat")));
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({ role: "system", content: `${COMPACTION_SUMMARY_PREFIX}: prior chat]` });
  });

  it("uses an already-prefixed narrative as-is rather than double-wrapping it", async () => {
    const narrative = `${COMPACTION_SUMMARY_PREFIX}: already summarised]`;
    const result = await applyStoredConversationSummary(context(messages, { sessionId: "sess-1" }), store(summary(narrative)));
    expect(result.messages[0]!.content).toBe(narrative);
  });

  it("does not prepend when the messages already open with a compaction summary", async () => {
    const withSummary = [{ role: "system" as const, content: `${COMPACTION_SUMMARY_PREFIX}: existing]` }, ...messages];
    const result = await applyStoredConversationSummary(context(withSummary, { sessionId: "sess-1" }), store(summary("new")));
    expect(result.messages).toHaveLength(2);
  });

  it("fails open (messages unchanged) when the store throws", async () => {
    const result = await applyStoredConversationSummary(context(messages, { sessionId: "sess-1" }), store(undefined, () => { throw new Error("db down"); }));
    expect(result.messages).toHaveLength(1);
  });
});
