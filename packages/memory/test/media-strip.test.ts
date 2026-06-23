import { describe, expect, it } from "vitest";

import type { ConversationMessage } from "../src/index.js";
import { stripStaleImageAttachments } from "../src/media-strip.js";

const img = (data: string, mimeType = "image/png") => ({ dataBase64: data, mimeType });

function userWithImage(content: string, data: string): ConversationMessage {
  return { content, role: "user", attachments: [img(data)] };
}

describe("stripStaleImageAttachments", () => {
  it("returns the original array reference when there are no inline images (no-op)", () => {
    const messages: ConversationMessage[] = [
      { content: "hi", role: "user" },
      { content: "hello", role: "assistant" }
    ];
    const result = stripStaleImageAttachments(messages);
    expect(result.messages).toBe(messages);
    expect(result.strippedCount).toBe(0);
  });

  it("strips inline images from turns BEFORE the last user message, keeping the current turn's image", () => {
    const messages: ConversationMessage[] = [
      userWithImage("first photo", "AAAA".repeat(1000)),
      { content: "I see a cat", role: "assistant" },
      userWithImage("now this one", "BBBB".repeat(1000))
    ];
    const { messages: out, strippedCount } = stripStaleImageAttachments(messages);
    expect(strippedCount).toBe(1);
    // old turn: image dropped, placeholder note appended
    expect(out[0]?.attachments).toBeUndefined();
    expect(out[0]?.content).toContain("first photo");
    expect(out[0]?.content).toContain("[image omitted: image/png");
    // current turn: image preserved
    expect(out[2]?.attachments).toHaveLength(1);
    expect(out[2]?.attachments?.[0]?.dataBase64).toBe("BBBB".repeat(1000));
  });

  it("keeps URL attachments (cheap refs) and only drops inline base64 images", () => {
    const messages: ConversationMessage[] = [
      {
        content: "mixed",
        role: "user",
        attachments: [img("CCCC".repeat(500)), { mimeType: "image/png", url: "https://x/y.png" }]
      },
      { content: "ok", role: "assistant" },
      { content: "next", role: "user" }
    ];
    const { messages: out, strippedCount } = stripStaleImageAttachments(messages);
    expect(strippedCount).toBe(1);
    expect(out[0]?.attachments).toHaveLength(1);
    expect(out[0]?.attachments?.[0]?.url).toBe("https://x/y.png");
  });

  it("is a no-op when the only image is in the last user turn", () => {
    const messages: ConversationMessage[] = [
      { content: "hi", role: "user" },
      { content: "yo", role: "assistant" },
      userWithImage("look", "DDDD".repeat(1000))
    ];
    const result = stripStaleImageAttachments(messages);
    expect(result.strippedCount).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("does not strip non-image inline attachments (e.g. PDFs)", () => {
    const messages: ConversationMessage[] = [
      { content: "doc", role: "user", attachments: [{ mimeType: "application/pdf", dataBase64: "EEEE".repeat(1000) }] },
      { content: "ok", role: "assistant" },
      { content: "next", role: "user" }
    ];
    const result = stripStaleImageAttachments(messages);
    expect(result.strippedCount).toBe(0);
  });
});
