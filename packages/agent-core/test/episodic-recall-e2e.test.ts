/**
 * End-to-end integration test for Context Engineering Phase 3.
 *
 * Wires a real `InMemoryConversationSummaryStore` + the new
 * `StoreBackedEpisodicRecallProvider` + an `AgentRuntime` with the
 * diagnostic model provider, seeds the store with past sessions,
 * runs a new request, and asserts the prior session's narrative
 * surfaces in the request the model sees.
 */

import { describe, expect, it } from "vitest";

import { DiagnosticModelProvider } from "@muse/model";
import { InMemoryConversationSummaryStore } from "@muse/memory";

import { AgentRuntime } from "../src/index.js";
import { StoreBackedEpisodicRecallProvider } from "../src/episodic-recall.js";

describe("episodic recall end-to-end", () => {
  it("surfaces a stored conversation summary into the new session's system prompt", async () => {
    const summaryStore = new InMemoryConversationSummaryStore();
    await summaryStore.save({
      narrative: "Decided to use Kysely for DB access; Prisma rejected for build-time cost",
      sessionId: "past-session-1",
      summarizedUpToIndex: 12,
      userId: "stark"
    });
    await summaryStore.save({
      narrative: "Discord integration design and afterStore schema review",
      sessionId: "past-session-2",
      summarizedUpToIndex: 8,
      userId: "stark"
    });
    await summaryStore.save({
      narrative: "Some other user's session about a totally unrelated chess problem",
      sessionId: "noise-1",
      summarizedUpToIndex: 4,
      userId: "other-user"
    });

    const recordedMessages: Array<{ role: string; content: string }> = [];
    const diagnostic = new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" });
    const spied = new Proxy(diagnostic, {
      get(target, prop, receiver) {
        if (prop === "generate") {
          return async (request: Parameters<typeof diagnostic.generate>[0]) => {
            for (const message of request.messages) {
              recordedMessages.push({ content: message.content, role: message.role });
            }
            return Reflect.get(target, prop, receiver).call(target, request);
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    });

    const runtime = new AgentRuntime({
      episodicRecallProvider: new StoreBackedEpisodicRecallProvider({
        minScore: 0.05,
        store: summaryStore,
        topK: 3
      }),
      modelProvider: spied
    });

    const result = await runtime.run({
      messages: [{ content: "Kysely Prisma DB build decision recap", role: "user" }],
      metadata: { sessionId: "new-session", userId: "stark" },
      model: "diagnostic/smoke"
    });

    expect(result.response).toBeDefined();
    // The system message the model saw must carry the [Episodic Memory] block
    // and reference the Kysely narrative from the past session.
    const systemMessages = recordedMessages.filter((message) => message.role === "system");
    expect(systemMessages.length).toBeGreaterThan(0);
    const systemBlob = systemMessages.map((message) => message.content).join("\n");
    expect(systemBlob).toContain("[Episodic Memory]");
    expect(systemBlob).toContain("Kysely");
    // Should NOT leak the other user's noise summary.
    expect(systemBlob).not.toContain("chess");
  });

  it("returns no episodic block when the store is empty", async () => {
    const summaryStore = new InMemoryConversationSummaryStore();
    const recordedSystemContent: string[] = [];
    const diagnostic = new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" });
    const spied = new Proxy(diagnostic, {
      get(target, prop, receiver) {
        if (prop === "generate") {
          return async (request: Parameters<typeof diagnostic.generate>[0]) => {
            for (const message of request.messages) {
              if (message.role === "system") {
                recordedSystemContent.push(message.content);
              }
            }
            return Reflect.get(target, prop, receiver).call(target, request);
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    });

    const runtime = new AgentRuntime({
      episodicRecallProvider: new StoreBackedEpisodicRecallProvider({ store: summaryStore }),
      modelProvider: spied
    });
    await runtime.run({
      messages: [{ content: "anything", role: "user" }],
      model: "diagnostic/smoke"
    });

    const systemBlob = recordedSystemContent.join("\n");
    expect(systemBlob).not.toContain("[Episodic Memory]");
  });
});
