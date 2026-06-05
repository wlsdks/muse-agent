import { describe, expect, it } from "vitest";

import {
  CHAT_GROUNDING_MAX_HITS,
  CHAT_GROUNDING_MIN_SCORE,
  formatChatGroundingBlock,
  groundChatTurn
} from "./chat-grounding.js";
import type { RecallHit } from "./commands-recall.js";

function hit(over: Partial<RecallHit> = {}): RecallHit {
  return { source: "notes", ref: "vpn.md", score: 0.7, snippet: "Office VPN MTU is 1380.", ...over };
}

describe("formatChatGroundingBlock", () => {
  it("emits an authoritative, citation-bearing block for a relevant hit", () => {
    const block = formatChatGroundingBlock([hit()]);
    expect(block).toContain("Office VPN MTU is 1380.");
    expect(block).toContain("[from vpn.md]");
    expect(block.toLowerCase()).toContain("authoritative");
  });

  it("returns '' when every hit is below the relevance threshold (refusal floor intact)", () => {
    expect(formatChatGroundingBlock([hit({ score: CHAT_GROUNDING_MIN_SCORE - 0.01 })])).toBe("");
  });

  it("returns '' for no hits", () => {
    expect(formatChatGroundingBlock([])).toBe("");
  });

  it("keeps a hit exactly at the threshold", () => {
    expect(formatChatGroundingBlock([hit({ score: CHAT_GROUNDING_MIN_SCORE })])).not.toBe("");
  });

  it("caps the injected passages at CHAT_GROUNDING_MAX_HITS", () => {
    const many = Array.from({ length: CHAT_GROUNDING_MAX_HITS + 3 }, (_unused, i) =>
      hit({ ref: `n${i}.md`, snippet: `fact ${i}`, score: 0.9 })
    );
    const block = formatChatGroundingBlock(many);
    const bullets = block.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets).toHaveLength(CHAT_GROUNDING_MAX_HITS);
  });

  it("respects a custom minScore", () => {
    expect(formatChatGroundingBlock([hit({ score: 0.4 })], 0.3)).not.toBe("");
    expect(formatChatGroundingBlock([hit({ score: 0.4 })], 0.5)).toBe("");
  });
});

describe("groundChatTurn", () => {
  it("returns '' for a too-short turn without touching retrieval", async () => {
    expect(await groundChatTurn("hi")).toBe("");
  });

  it("returns '' when MUSE_CHAT_GROUNDING=0 (kill switch) without retrieval", async () => {
    expect(await groundChatTurn("what is my office VPN MTU?", { env: { MUSE_CHAT_GROUNDING: "0" } })).toBe("");
  });

  it("fails soft to '' when retrieval throws (no index / Ollama down)", async () => {
    // No notes index + no test-embedding hook => searchRecall throws on embed; we swallow it.
    const block = await groundChatTurn("what is my office VPN MTU?", {
      env: { MUSE_NOTES_INDEX_FILE: "/nonexistent/notes-index.json", OLLAMA_BASE_URL: "http://127.0.0.1:1" }
    });
    expect(block).toBe("");
  });
});
