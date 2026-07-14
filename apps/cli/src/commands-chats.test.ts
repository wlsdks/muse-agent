import { describe, expect, it } from "vitest";

import { formatConversationList } from "./commands-chats.js";
import type { ConversationSummary } from "@muse/stores";

const NOW = new Date("2026-07-14T12:00:00.000Z");

function summary(over: Partial<ConversationSummary>): ConversationSummary {
  return {
    createdAt: "2026-07-14T09:00:00.000Z",
    id: "conv_deadbeef",
    origin: "cli",
    title: "a conversation",
    turnCount: 4,
    updatedAt: "2026-07-14T09:00:00.000Z",
    ...over
  };
}

describe("formatConversationList", () => {
  it("reports 'no conversations yet' for an empty list", () => {
    expect(formatConversationList([], undefined, NOW)).toContain("No conversations yet");
  });

  it("numbers each row and includes id prefix, title, turn count, relative time", () => {
    const text = formatConversationList(
      [summary({ id: "conv_aaaaaaaa", title: "plan Q3", turnCount: 6, updatedAt: "2026-07-14T11:55:00.000Z" })],
      undefined,
      NOW
    );
    expect(text).toMatch(/^1\. \[conv_aaaaaaaa\] plan Q3 — 6 turns, updated 5m ago\n$/u);
  });

  it("singularizes 'turn' for a 1-turn conversation", () => {
    const text = formatConversationList([summary({ turnCount: 1 })], undefined, NOW);
    expect(text).toContain("— 1 turn,");
    expect(text).not.toContain("1 turns");
  });

  it("marks the active conversation with '(active)' and no others", () => {
    const text = formatConversationList(
      [
        summary({ id: "conv_aaaaaaaa", title: "first" }),
        summary({ id: "conv_bbbbbbbb", title: "second" })
      ],
      "conv_bbbbbbbb",
      NOW
    );
    const lines = text.trim().split("\n");
    expect(lines[0]).not.toContain("(active)");
    expect(lines[1]).toContain("(active)");
  });

  it("lists in the order given (list() sorts by updatedAt desc — this function only numbers)", () => {
    const text = formatConversationList(
      [summary({ id: "conv_aaaaaaaa", title: "newest" }), summary({ id: "conv_bbbbbbbb", title: "older" })],
      undefined,
      NOW
    );
    const lines = text.trim().split("\n");
    expect(lines[0]).toContain("newest");
    expect(lines[1]).toContain("older");
  });
});
