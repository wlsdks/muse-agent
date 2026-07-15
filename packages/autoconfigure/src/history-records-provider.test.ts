import { searchHistory } from "@muse/recall";
import type { Conversation, ConversationSummary, ConversationTurn } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { buildHistoryRecords } from "./history-records-provider.js";

const episodes = [
  { id: "ep-1", userId: "u1", summary: "We discussed the VPN MTU fix.", endedAt: "2026-06-20T10:00:00Z" },
  { id: "ep-other", userId: "u2", summary: "Someone else's session." }
];

function fakeConversation(params: {
  readonly id: string;
  readonly title: string;
  readonly origin?: string;
  readonly updatedAt: string;
  readonly turns?: readonly ConversationTurn[];
}): Conversation {
  return {
    createdAt: params.updatedAt,
    id: params.id,
    origin: params.origin ?? "cli",
    title: params.title,
    turns: params.turns ?? [],
    updatedAt: params.updatedAt
  };
}

function conversationDeps(conversations: readonly Conversation[]): {
  readonly listConversations: () => readonly ConversationSummary[];
  readonly getConversation: (id: string) => Conversation | undefined;
} {
  const byId = new Map(conversations.map((c) => [c.id, c]));
  return {
    listConversations: () =>
      [...conversations]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((c) => ({ createdAt: c.createdAt, id: c.id, origin: c.origin, title: c.title, turnCount: c.turns.length, updatedAt: c.updatedAt })),
    getConversation: (id) => byId.get(id)
  };
}

describe("buildHistoryRecords — record sources + optional embedding (A2)", () => {
  it("collects the user's own episodes as labelled history records", async () => {
    const records = await buildHistoryRecords({ readEpisodes: () => episodes, userId: "u1" });
    expect(records.map((r) => r.ref)).toEqual(["ep-1"]);
    expect(records[0]!.source).toBe("episodes");
    expect(records[0]!.embedding).toBeUndefined();
  });

  it("attaches an embedding to each record when an embedder is injected", async () => {
    const embed = (text: string): Promise<readonly number[]> => Promise.resolve([text.length, 0, 1]);
    const records = await buildHistoryRecords({ readEpisodes: () => episodes, userId: "u1", embed });
    expect(records).toHaveLength(1);
    expect(records[0]!.embedding).toEqual([episodes[0]!.summary.length, 0, 1]);
  });

  it("per-record fail-soft: a thrown embed leaves that record lexical-only, never drops it", async () => {
    const embed = (): Promise<readonly number[]> => Promise.reject(new Error("ollama down"));
    const records = await buildHistoryRecords({ readEpisodes: () => episodes, userId: "u1", embed });
    expect(records.map((r) => r.ref)).toEqual(["ep-1"]);
    expect(records[0]!.embedding).toBeUndefined();
  });

  it("drops an empty embedding rather than attaching a useless zero-length vector", async () => {
    const embed = (): Promise<readonly number[]> => Promise.resolve([]);
    const records = await buildHistoryRecords({ readEpisodes: () => episodes, userId: "u1", embed });
    expect(records[0]!.embedding).toBeUndefined();
  });
});

describe("buildHistoryRecords — conversations source (R3-1: your Telegram/web/CLI chats are findable too)", () => {
  it("finds a Telegram-origin conversation by a KOREAN query matching its TURN content, not the title", async () => {
    const telegramChat = fakeConversation({
      id: "telegram:555",
      origin: "telegram",
      title: "Weekend chat",
      turns: [
        { content: "지난주에 텔레그램에서 알려준 컨퍼런스 할인코드가 뭐였지?", role: "user" },
        { content: "할인코드는 EARLYBIRD25 였어요.", role: "assistant" }
      ],
      updatedAt: "2026-07-10T09:00:00.000Z"
    });
    const records = await buildHistoryRecords({ readEpisodes: () => [], userId: "u1", ...conversationDeps([telegramChat]) });
    const hits = searchHistory("컨퍼런스 할인코드", records);
    expect(hits[0]?.ref).toBe("telegram:555");
    expect(hits[0]?.source).toBe("conversations");
  });

  it("finds a conversation by an ENGLISH query matching its turn content", async () => {
    const cliChat = fakeConversation({
      id: "conv_aaaa1111",
      title: "random",
      turns: [{ content: "What was that VPN configuration change we discussed last night?", role: "user" }],
      updatedAt: "2026-07-11T09:00:00.000Z"
    });
    const records = await buildHistoryRecords({ readEpisodes: () => [], userId: "u1", ...conversationDeps([cliChat]) });
    const hits = searchHistory("VPN configuration change", records);
    expect(hits[0]?.ref).toBe("conv_aaaa1111");
  });

  it("finds a conversation whose ONLY match is the conversation TITLE (turns don't share the query terms)", async () => {
    const chat = fakeConversation({
      id: "conv_bbbb2222",
      title: "Sourdough starter feeding schedule",
      turns: [{ content: "ok sounds good", role: "user" }, { content: "noted, thanks", role: "assistant" }],
      updatedAt: "2026-07-09T09:00:00.000Z"
    });
    const records = await buildHistoryRecords({ readEpisodes: () => [], userId: "u1", ...conversationDeps([chat]) });
    const hits = searchHistory("sourdough starter feeding", records);
    expect(hits[0]?.ref).toBe("conv_bbbb2222");
  });

  it("leaves the recency tiebreak among OTHER sources (episodes) unaffected by conversation records mixed in", async () => {
    const olderEpisode = { endedAt: "2026-01-01T00:00:00Z", id: "ep-old", summary: "alpha report review", userId: "u1" };
    const newerEpisode = { endedAt: "2026-06-01T00:00:00Z", id: "ep-new", summary: "alpha report review", userId: "u1" };
    const unrelatedChat = fakeConversation({
      id: "conv_cccc3333",
      title: "totally unrelated topic",
      turns: [{ content: "totally unrelated content", role: "user" }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    const records = await buildHistoryRecords({
      readEpisodes: () => [olderEpisode, newerEpisode],
      userId: "u1",
      ...conversationDeps([unrelatedChat])
    });
    const hits = searchHistory("alpha report review", records);
    expect(hits.map((h) => h.ref)).toEqual(["ep-new", "ep-old"]);
  });

  it("returns zero conversation records (no crash) when the conversation store is empty", async () => {
    const records = await buildHistoryRecords({ readEpisodes: () => [], userId: "u1", ...conversationDeps([]) });
    expect(records).toEqual([]);
  });

  it("caps a 200-turn conversation's record to the recent-turn window + maxChars (no unbounded record)", async () => {
    const turns: ConversationTurn[] = Array.from({ length: 200 }, (_, i) => ({ content: `turn-${i.toString()}-marker filler text to pad length`, role: "user" as const }));
    const bigChat = fakeConversation({ id: "conv_dddd4444", title: "long thread", turns, updatedAt: "2026-07-12T09:00:00.000Z" });
    const records = await buildHistoryRecords({ readEpisodes: () => [], userId: "u1", ...conversationDeps([bigChat]) });
    expect(records).toHaveLength(1);
    const text = records[0]!.text;
    expect(text.length).toBeLessThanOrEqual(4000);
    // Only the most recent turn-window survives — the very first turn is long gone.
    expect(text).not.toContain("turn-0-marker");
    expect(text).toContain("turn-199-marker");
  });

  it("caps to the 50 MOST RECENT conversations, dropping older ones (bounds per-call get() cost)", async () => {
    const conversations = Array.from({ length: 55 }, (_, i) =>
      fakeConversation({
        id: `conv_${i.toString().padStart(3, "0")}`,
        title: `chat ${i.toString()}`,
        turns: [{ content: "hello there", role: "user" }],
        updatedAt: new Date(2026, 0, 1 + i).toISOString()
      }));
    const records = await buildHistoryRecords({ readEpisodes: () => [], userId: "u1", ...conversationDeps(conversations) });
    expect(records).toHaveLength(50);
    // Newest 50 (indices 5..54) survive; the 5 oldest (indices 0..4) are dropped.
    expect(records.some((r) => r.ref === "conv_054")).toBe(true);
    expect(records.some((r) => r.ref === "conv_004")).toBe(false);
  });

  it("is fail-soft: a throwing conversation store still returns episodes (never blocks other sources)", async () => {
    const records = await buildHistoryRecords({
      readEpisodes: () => episodes,
      userId: "u1",
      listConversations: () => {
        throw new Error("conversations store unreadable");
      },
      getConversation: () => undefined
    });
    expect(records.map((r) => r.ref)).toEqual(["ep-1"]);
  });

  it("is fail-soft per-conversation: one throwing get() drops only that conversation", async () => {
    const good = fakeConversation({ id: "conv_ok", title: "fine", turns: [{ content: "hello there", role: "user" }], updatedAt: "2026-07-05T00:00:00.000Z" });
    const records = await buildHistoryRecords({
      readEpisodes: () => [],
      userId: "u1",
      listConversations: () => [
        { createdAt: good.createdAt, id: good.id, origin: good.origin, title: good.title, turnCount: good.turns.length, updatedAt: good.updatedAt },
        { createdAt: "2026-07-06T00:00:00.000Z", id: "conv_broken", origin: "cli", title: "broken", turnCount: 1, updatedAt: "2026-07-06T00:00:00.000Z" }
      ],
      getConversation: (id) => {
        if (id === "conv_broken") throw new Error("read failed");
        return id === "conv_ok" ? good : undefined;
      }
    });
    expect(records.map((r) => r.ref)).toEqual(["conv_ok"]);
  });
});
