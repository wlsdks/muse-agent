import type { ModelMessage, ModelTool, ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { seedDeduplicatorFromHistory } from "../src/model-loop.js";
import { ToolCallDeduplicator } from "../src/tool-call-deduplicator.js";

const sendEmail: ModelTool = { name: "send_email", description: "send", inputSchema: { type: "object" }, risk: "write" };
const call = (id: string, args: Record<string, unknown>): ModelToolCall => ({ id, name: "send_email", arguments: args });

// A resumed run: the model already called send_email and got "sent" back; the replay
// carries both, then the (small) model re-issues the SAME call.
const resumedHistory: readonly ModelMessage[] = [
  { content: "email mina", role: "user" },
  { content: "", role: "assistant", toolCalls: [call("c1", { to: "mina", body: "hi" })] },
  { content: "sent ✓", role: "tool", toolCallId: "c1" }
];

describe("seedDeduplicatorFromHistory — resume must not RE-EXECUTE a completed side-effecting tool", () => {
  it("a re-issued identical write call after resume is DEDUPLICATED (returns the cached result, no re-send)", () => {
    const dedup = new ToolCallDeduplicator();
    seedDeduplicatorFromHistory(dedup, resumedHistory, [sendEmail]);
    const decision = dedup.check(call("c2", { to: "mina", body: "hi" })); // same name+args, new id
    expect(decision.duplicate).toBe(true);
    expect(decision.duplicate && decision.result.output).toBe("sent ✓");
  });

  it("a DIFFERENT call (different args) is NOT deduplicated — only the exact replayed action is guarded", () => {
    const dedup = new ToolCallDeduplicator();
    seedDeduplicatorFromHistory(dedup, resumedHistory, [sendEmail]);
    expect(dedup.check(call("c3", { body: "hi", to: "SOMEONE-ELSE" })).duplicate).toBe(false);
  });

  it("a normal (non-resume) run with no completed tool calls seeds NOTHING (the call still runs)", () => {
    const dedup = new ToolCallDeduplicator();
    seedDeduplicatorFromHistory(dedup, [{ content: "email mina", role: "user" }], [sendEmail]);
    expect(dedup.check(call("c1", { to: "mina", body: "hi" })).duplicate).toBe(false);
  });

  it("an UNANSWERED call (the crash point — no tool result) is left runnable, not seeded", () => {
    const dedup = new ToolCallDeduplicator();
    const crashedMidCall: readonly ModelMessage[] = [
      { content: "email mina", role: "user" },
      { content: "", role: "assistant", toolCalls: [call("c1", { to: "mina", body: "hi" })] }
      // no tool-result message — the run crashed before send_email returned
    ];
    seedDeduplicatorFromHistory(dedup, crashedMidCall, [sendEmail]);
    expect(dedup.check(call("c2", { to: "mina", body: "hi" })).duplicate).toBe(false); // must RUN it (it never completed)
  });
});
