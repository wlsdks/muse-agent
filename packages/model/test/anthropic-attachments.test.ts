import { describe, expect, it } from "vitest";

import { anthropicModelCapabilities, toAnthropicMessage } from "../src/provider-anthropic.js";

describe("toAnthropicMessage — image attachment serialization (G7)", () => {
  it("serializes a base64 attachment into an Anthropic image block (base64 source)", () => {
    const msg = toAnthropicMessage({
      attachments: [{ dataBase64: "AAAA", mimeType: "image/png" }],
      content: "what is this?",
      role: "user"
    }) as { role: string; content: Array<Record<string, unknown>> };
    expect(msg.role).toBe("user");
    expect(Array.isArray(msg.content)).toBe(true);
    expect(msg.content).toContainEqual({ text: "what is this?", type: "text" });
    expect(msg.content).toContainEqual({
      source: { data: "AAAA", media_type: "image/png", type: "base64" },
      type: "image"
    });
  });

  it("serializes a URL attachment into an Anthropic image block (url source)", () => {
    const msg = toAnthropicMessage({
      attachments: [{ mimeType: "image/jpeg", url: "https://x.test/cat.jpg" }],
      content: "",
      role: "user"
    }) as { content: Array<Record<string, unknown>> };
    expect(msg.content).toContainEqual({
      source: { type: "url", url: "https://x.test/cat.jpg" },
      type: "image"
    });
    // No empty text block when content is empty.
    expect(msg.content.some((p) => p.type === "text")).toBe(false);
  });

  it("leaves a plain text message as a string (no attachments)", () => {
    const msg = toAnthropicMessage({ content: "hello", role: "user" }) as { content: unknown };
    expect(msg.content).toBe("hello");
  });

  it("now declares vision:true (attachments are wired)", () => {
    expect(anthropicModelCapabilities("claude-3-7-sonnet").vision).toBe(true);
  });
});
