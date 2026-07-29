import type { ModelMessage, ModelTool, ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { seedDeduplicatorFromHistory } from "../src/model-loop.js";
import { ToolCallDeduplicator } from "../src/tool-call-deduplicator.js";

const sendEmail: ModelTool = { name: "send_email", description: "send", inputSchema: { type: "object" }, risk: "write" };
const readInbox: ModelTool = { name: "read_inbox", description: "read", inputSchema: { type: "object" }, risk: "read" };
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

  it("an UNANSWERED mutating call is effect-unknown and cannot auto-replay", () => {
    const dedup = new ToolCallDeduplicator();
    const crashedMidCall: readonly ModelMessage[] = [
      { content: "email mina", role: "user" },
      { content: "", role: "assistant", toolCalls: [call("c1", { to: "mina", body: "hi" })] }
      // no tool-result message — the run crashed before send_email returned
    ];
    seedDeduplicatorFromHistory(dedup, crashedMidCall, [sendEmail]);
    const decision = dedup.check(call("c2", { to: "mina", body: "hi" }));
    expect(decision.duplicate).toBe(true);
    expect(decision.duplicate && decision.result.status).toBe("blocked");
    expect(decision.duplicate && decision.result.output).toContain('"effectStatus":"unknown"');
    expect(decision.duplicate && decision.result.output).toContain("reconcile");
  });

  it("an UNANSWERED read-only call remains runnable after resume", () => {
    const dedup = new ToolCallDeduplicator();
    const readCall: ModelToolCall = { id: "r1", name: "read_inbox", arguments: { folder: "inbox" } };
    seedDeduplicatorFromHistory(dedup, [
      { content: "check inbox", role: "user" },
      { content: "", role: "assistant", toolCalls: [readCall] }
    ], [readInbox]);
    expect(dedup.check({ ...readCall, id: "r2" }).duplicate).toBe(false);
  });

  it("preserves effect-unknown when a later identical call has a result", () => {
    const dedup = new ToolCallDeduplicator();
    seedDeduplicatorFromHistory(dedup, [
      { content: "", role: "assistant", toolCalls: [call("unknown", { to: "mina", body: "hi" })] },
      { content: "", role: "assistant", toolCalls: [call("completed", { to: "mina", body: "hi" })] },
      { content: "sent", name: "send_email", role: "tool", toolCallId: "completed" }
    ], [sendEmail]);
    const decision = dedup.check(call("retry", { to: "mina", body: "hi" }));
    expect(decision.duplicate).toBe(true);
    expect(decision.duplicate && decision.result.status).toBe("blocked");
    expect(decision.duplicate && decision.result.output).toContain('"effectStatus":"unknown"');
  });

  it.each([
    {
      label: "result precedes its call",
      messages: [
        { content: "sent", name: "send_email", role: "tool", toolCallId: "same" },
        { content: "", role: "assistant", toolCalls: [call("same", { to: "mina", body: "hi" })] }
      ] satisfies ModelMessage[]
    },
    {
      label: "result name conflicts with its call",
      messages: [
        { content: "", role: "assistant", toolCalls: [call("same", { to: "mina", body: "hi" })] },
        { content: "sent", name: "delete_email", role: "tool", toolCallId: "same" }
      ] satisfies ModelMessage[]
    }
  ])("does not mis-pair a mutating call when $label", ({ messages }) => {
    const dedup = new ToolCallDeduplicator();
    seedDeduplicatorFromHistory(dedup, messages, [sendEmail]);
    const decision = dedup.check(call("retry", { to: "mina", body: "hi" }));
    expect(decision.duplicate).toBe(true);
    expect(decision.duplicate && decision.result.status).toBe("blocked");
  });
});
