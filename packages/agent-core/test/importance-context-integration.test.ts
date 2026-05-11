/**
 * Integration: when `activeContextProvider` resolves an active task,
 * its title flows into `ConversationTrimOptions.importanceContext` so
 * `scoreMessageImportance` recognises messages that reference the
 * current task. Without this plumbing (the bug closed by Gap #2),
 * Phase 5 importance compaction had no active task to match against.
 */

import { describe, expect, it } from "vitest";

import { DiagnosticModelProvider } from "@muse/model";
import { scoreMessageImportance, type ConversationMessage } from "@muse/memory";

import { AgentRuntime } from "../src/index.js";
import { DefaultActiveContextProvider, type ActiveTaskResolver } from "../src/active-context.js";

describe("importance context plumbing", () => {
  it("flows active task title from ActiveContextProvider into the trim's importanceContext", async () => {
    const taskResolver: ActiveTaskResolver = {
      resolve() {
        return { id: "T-42", title: "Ship roadmap doc" };
      }
    };
    const activeContextProvider = new DefaultActiveContextProvider({
      activeTaskResolver: taskResolver,
      defaultTimezone: "UTC",
      now: () => new Date("2026-05-11T08:00:00.000Z")
    });

    const runtime = new AgentRuntime({
      activeContextProvider,
      contextWindow: {
        compactionStrategy: "importance",
        importanceThreshold: 0.5,
        maxContextWindowTokens: 200,
        outputReserveTokens: 20
      },
      modelProvider: new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" })
    });

    // 9 filler turns + one user message that names the active task —
    // with `importanceContext.activeTaskTitle` populated, that message
    // should outscore the filler. Without the plumbing it would not.
    const messages: ConversationMessage[] = [
      ...Array.from({ length: 8 }, (_, index) => ({
        content: `casual chitchat number ${(index + 1).toString()}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const)
      })),
      { content: "Update on Ship roadmap doc?", role: "user" }
    ];

    const result = await runtime.run({
      messages,
      metadata: { sessionId: "s-1", userId: "stark" },
      model: "diagnostic/smoke"
    });

    expect(result.contextWindow).toBeDefined();

    // Sanity: importance scoring with active task lifts the task-named
    // message above casual chat (this verifies the scorer behaviour
    // that the runtime plumbing must now feed).
    const base = scoreMessageImportance(
      { content: "casual chitchat", role: "user" },
      { messageIndex: 0, totalMessages: 10 }
    );
    const targeted = scoreMessageImportance(
      { content: "Update on Ship roadmap doc?", role: "user" },
      { activeTaskTitle: "Ship roadmap doc", messageIndex: 8, totalMessages: 10 }
    );
    expect(targeted).toBeGreaterThan(base);
  });
});
