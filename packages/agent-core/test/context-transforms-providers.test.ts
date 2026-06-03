import type { ExemplarRetriever } from "@muse/prompts";
import { describe, expect, it } from "vitest";

import type { ActiveContextProvider, ActiveContextSnapshot } from "../src/active-context.js";
import {
  applyEpisodicRecall,
  applyInboxContext,
  applyInboxContextWithGrounding,
  applyPromptExemplars,
  inboxGroundingSources,
  resolveActiveContextSnapshot,
} from "../src/context-transforms.js";
import type { EpisodicRecallProvider, EpisodicRecallSnapshot } from "../src/episodic-recall.js";
import type { InboxContextProvider, InboxSnapshot } from "../src/inbox-context.js";
import type { AgentRunContext } from "../src/types.js";

const context = (metadata: Record<string, unknown> = { userId: "u1" }, messages = [{ role: "user" as const, content: "q" }]): AgentRunContext => ({
  runId: "run-1",
  startedAt: new Date("2026-01-01T09:00:00Z"),
  input: { model: "m", messages, metadata },
});
const throwing = () => {
  throw new Error("provider down");
};

describe("resolveActiveContextSnapshot", () => {
  const snapshot: ActiveContextSnapshot = { nowIso: "2026-01-01T09:00:00Z", weekday: "Thursday", timezone: "UTC", localHour: 9 };

  it("returns undefined when no provider is configured", async () => {
    expect(await resolveActiveContextSnapshot(context(), undefined)).toBeUndefined();
  });

  it("returns the resolved snapshot", async () => {
    const provider: ActiveContextProvider = { resolve: async () => snapshot };
    expect(await resolveActiveContextSnapshot(context(), provider)).toEqual(snapshot);
  });

  it("normalises a null resolution to undefined and fails open on a throw", async () => {
    expect(await resolveActiveContextSnapshot(context(), { resolve: async () => null })).toBeUndefined();
    expect(await resolveActiveContextSnapshot(context(), { resolve: throwing } as ActiveContextProvider)).toBeUndefined();
  });
});

describe("applyInboxContext", () => {
  const snapshot: InboxSnapshot = {
    messages: [{ providerId: "slack", source: "C1", sender: "bob", receivedAtIso: "2026-01-01T08:00:00Z", text: "hi there" }],
  };

  it("returns the input untouched when no provider is configured", async () => {
    const ctx = context();
    expect(await applyInboxContext(ctx, undefined)).toBe(ctx.input);
  });

  it("injects a [Recent Messages] section and records the applied flag + count", async () => {
    const result = await applyInboxContext(context(), { resolve: async () => snapshot });
    expect(result.messages[0]).toMatchObject({ role: "system" });
    expect(result.messages[0]!.content).toContain("Recent Messages");
    expect(result.metadata).toMatchObject({ inboxContextApplied: true, inboxContextMessageCount: 1 });
  });

  it("leaves the input unchanged when the snapshot has no messages", async () => {
    expect((await applyInboxContext(context(), { resolve: async () => ({ messages: [] }) })).messages).toHaveLength(1);
  });

  it("fails open and flags the failure when the provider throws", async () => {
    const result = await applyInboxContext(context(), { resolve: throwing } as InboxContextProvider);
    expect(result.metadata).toMatchObject({ inboxContextFailed: true });
    expect(result.messages).toHaveLength(1);
  });
});

describe("inboxGroundingSources — injected messages as citeable evidence", () => {
  it("maps each message to { source: inbox/<provider>, text: <sender>: <body> }", () => {
    const sources = inboxGroundingSources({
      messages: [
        { providerId: "telegram", source: "dm", sender: "Sarah", receivedAtIso: "2026-01-01T08:00:00Z", text: "can you call me back?" },
        { providerId: "slack", source: "C1", receivedAtIso: "2026-01-01T08:05:00Z", text: "deploy is green" },
      ],
    });
    expect(sources).toEqual([
      { source: "inbox/telegram", text: "Sarah: can you call me back?" },
      { source: "inbox/slack", text: "deploy is green" },
    ]);
  });

  it("returns [] for an undefined or empty snapshot, and skips an empty body", () => {
    expect(inboxGroundingSources(undefined)).toEqual([]);
    expect(inboxGroundingSources({ messages: [] })).toEqual([]);
    expect(inboxGroundingSources({
      messages: [{ providerId: "slack", source: "C1", receivedAtIso: "2026-01-01T08:00:00Z", text: "   " }],
    })).toEqual([]);
  });
});

describe("applyInboxContextWithGrounding — one resolve, input + grounding evidence together", () => {
  const snapshot: InboxSnapshot = {
    messages: [{ providerId: "slack", source: "C1", sender: "bob", receivedAtIso: "2026-01-01T08:00:00Z", text: "hi there" }],
  };

  it("returns the [Recent Messages] input AND the grounding sources from a SINGLE resolve", async () => {
    let resolveCount = 0;
    const provider: InboxContextProvider = { resolve: async () => { resolveCount += 1; return snapshot; } };
    const result = await applyInboxContextWithGrounding(context(), provider);
    expect(resolveCount).toBe(1);
    expect(result.input.messages[0]!.content).toContain("Recent Messages");
    expect(result.groundingSources).toEqual([{ source: "inbox/slack", text: "bob: hi there" }]);
  });

  it("yields no grounding sources when no provider / empty snapshot / a throw", async () => {
    expect((await applyInboxContextWithGrounding(context(), undefined)).groundingSources).toEqual([]);
    expect((await applyInboxContextWithGrounding(context(), { resolve: async () => ({ messages: [] }) })).groundingSources).toEqual([]);
    expect((await applyInboxContextWithGrounding(context(), { resolve: throwing } as InboxContextProvider)).groundingSources).toEqual([]);
  });
});

describe("applyEpisodicRecall", () => {
  const snapshot: EpisodicRecallSnapshot = {
    matches: [{ sessionId: "s1", narrative: "prior session fact", createdAtIso: "2025-12-01T00:00:00Z", similarity: 0.9 }],
  };

  it("returns the input untouched with no provider", async () => {
    const ctx = context();
    expect(await applyEpisodicRecall(ctx, undefined)).toBe(ctx.input);
  });

  it("skips (without calling the provider) when the latest user prompt is empty", async () => {
    const ctx = context({ userId: "u1" }, []);
    const provider: EpisodicRecallProvider = { resolve: throwing };
    expect(await applyEpisodicRecall(ctx, provider)).toBe(ctx.input);
  });

  it("injects an [Episodic Memory] section and records the applied flag + match count", async () => {
    const result = await applyEpisodicRecall(context(), { resolve: async () => snapshot });
    expect(result.messages[0]).toMatchObject({ role: "system" });
    expect(result.metadata).toMatchObject({ episodicRecallApplied: true, episodicRecallMatchCount: 1 });
  });

  it("leaves the input unchanged when there are no matches", async () => {
    expect((await applyEpisodicRecall(context(), { resolve: async () => ({ matches: [] }) })).messages).toHaveLength(1);
  });

  it("fails open and flags the failure when the provider throws", async () => {
    const result = await applyEpisodicRecall(context(), { resolve: throwing } as EpisodicRecallProvider);
    expect(result.metadata).toMatchObject({ episodicRecallFailed: true });
  });
});

describe("applyPromptExemplars", () => {
  it("returns the context untouched with no retriever or an empty user prompt", async () => {
    const ctx = context();
    expect(await applyPromptExemplars(ctx, undefined, 3)).toBe(ctx);
    const blank = context({ userId: "u1" }, []);
    expect(await applyPromptExemplars(blank, { retrieveTopK: throwing } as ExemplarRetriever, 3)).toBe(blank);
  });

  it("appends a prompt-exemplars section and flags it applied", async () => {
    const result = await applyPromptExemplars(context(), { retrieveTopK: async () => "Q: example\nA: answer" }, 3);
    expect(result.input.messages[0]).toMatchObject({ role: "system" });
    expect(result.input.metadata).toMatchObject({ promptExemplarApplied: true });
  });

  it("leaves the context unchanged when the retriever returns an empty string", async () => {
    const result = await applyPromptExemplars(context(), { retrieveTopK: async () => "" }, 3);
    expect(result.input.messages).toHaveLength(1);
  });

  it("fails open and flags retrieval failure when the retriever throws", async () => {
    const result = await applyPromptExemplars(context(), { retrieveTopK: throwing } as ExemplarRetriever, 3);
    expect(result.input.metadata).toMatchObject({ promptExemplarRetrievalFailed: true });
  });
});
