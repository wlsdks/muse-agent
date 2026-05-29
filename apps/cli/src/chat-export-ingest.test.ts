import { describe, expect, it } from "vitest";

import { detectChatExport, ingestChatExport, slugifyTitle } from "./chat-export-ingest.js";

const chatgptExport = [
  {
    title: "Q3 launch plan",
    create_time: 1_700_000_000,
    mapping: {
      root: { id: "root", message: null, parent: null, children: ["a"] },
      a: { id: "a", message: { author: { role: "system" }, create_time: 1, content: { content_type: "text", parts: ["you are a helpful assistant"] } } },
      b: { id: "b", message: { author: { role: "user" }, create_time: 10, content: { content_type: "text", parts: ["who owns the launch deck?"] } } },
      c: { id: "c", message: { author: { role: "assistant" }, create_time: 20, content: { content_type: "text", parts: ["Jin owns the deck; ship the beta on the 12th."] } } },
      img: { id: "img", message: { author: { role: "user" }, create_time: 15, content: { content_type: "image_asset_pointer", parts: [{ asset_pointer: "file-x" }] } } }
    }
  }
];

const claudeExport = [
  {
    uuid: "u1",
    name: "Insurance renewal",
    created_at: "2026-05-01T09:00:00Z",
    chat_messages: [
      { sender: "human", text: "when does my home insurance renew?" },
      { sender: "assistant", content: [{ type: "text", text: "Policy 7741-A renews 2026-09-14." }] },
      { sender: "tool", text: "(ignored non-conversational)" }
    ]
  }
];

describe("detectChatExport", () => {
  it("recognises ChatGPT (mapping) and Claude (chat_messages) shapes; rejects others", () => {
    expect(detectChatExport(chatgptExport)).toBe("chatgpt");
    expect(detectChatExport(claudeExport)).toBe("claude");
    expect(detectChatExport([])).toBeUndefined();
    expect(detectChatExport([{ foo: 1 }])).toBeUndefined();
    expect(detectChatExport({ not: "an array" })).toBeUndefined();
  });
});

describe("ingestChatExport — ChatGPT", () => {
  it("orders turns by create_time, keeps user+assistant, drops system + non-text parts", () => {
    const [conv] = ingestChatExport(chatgptExport);
    expect(conv!.title).toBe("Q3 launch plan");
    expect(conv!.slug).toBe("q3-launch-plan");
    expect(conv!.createdIso).toBe("2023-11-14T22:13:20.000Z");
    expect(conv!.markdown).toContain("**You:** who owns the launch deck?");
    expect(conv!.markdown).toContain("**Assistant:** Jin owns the deck");
    expect(conv!.markdown).not.toContain("helpful assistant"); // system dropped
    expect(conv!.markdown).not.toContain("asset_pointer"); // non-text part dropped
    // user turn precedes assistant turn (create_time order)
    expect(conv!.markdown.indexOf("**You:**")).toBeLessThan(conv!.markdown.indexOf("**Assistant:**"));
  });
});

describe("ingestChatExport — Claude", () => {
  it("maps human→You, reads .text or .content[].text, drops tool turns", () => {
    const [conv] = ingestChatExport(claudeExport);
    expect(conv!.title).toBe("Insurance renewal");
    expect(conv!.createdIso).toBe("2026-05-01T09:00:00Z");
    expect(conv!.markdown).toContain("**You:** when does my home insurance renew?");
    expect(conv!.markdown).toContain("**Assistant:** Policy 7741-A renews 2026-09-14.");
    expect(conv!.markdown).not.toContain("non-conversational");
  });
});

describe("ingestChatExport — robustness", () => {
  it("returns [] for an unrecognized / empty export and skips a conversation with no text", () => {
    expect(ingestChatExport([{ foo: 1 }])).toEqual([]);
    expect(ingestChatExport([{ name: "empty", chat_messages: [{ sender: "human", text: "" }] }])).toEqual([]);
  });

  it("de-collides slugs for same-titled conversations", () => {
    const dup = [
      { name: "notes", chat_messages: [{ sender: "human", text: "a" }] },
      { name: "notes", chat_messages: [{ sender: "human", text: "b" }] }
    ];
    expect(ingestChatExport(dup).map((c) => c.slug)).toEqual(["notes", "notes-2"]);
  });
});

describe("slugifyTitle", () => {
  it("keeps hangul + alnum, collapses the rest, falls back when empty", () => {
    expect(slugifyTitle("Q3 / Launch!!", "fb")).toBe("q3-launch");
    expect(slugifyTitle("보험 갱신", "fb")).toBe("보험-갱신");
    expect(slugifyTitle("###", "fb-7")).toBe("fb-7");
  });
});
