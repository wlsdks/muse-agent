/**
 * Phase B regression guard — multimodal binary attachment wire-up.
 *
 * Verifies that a `ModelMessage` carrying `attachments` is rendered
 * into the right provider-specific shape:
 *
 *   - OpenAI Chat Completions: multipart `content` array with
 *     `{ type: "image_url", image_url: { url } }` parts.
 *   - Gemini: `inlineData: { mimeType, data }` for base64 or
 *     `fileData: { mimeType, fileUri }` for URL refs.
 *
 * Messages WITHOUT attachments still produce the legacy compact
 * shape so existing callers are unaffected.
 */

import { describe, expect, it } from "vitest";

import { toGeminiRequest, toOpenAIChatRequest } from "../src/provider-wire.js";

describe("toOpenAIChatRequest with attachments (phase B)", () => {
  it("expands a user message into multipart image_url parts when attachments are present", () => {
    const wire = toOpenAIChatRequest(
      {
        messages: [
          {
            attachments: [
              { dataBase64: "BASE64DATA", mimeType: "image/png" },
              { mimeType: "image/jpeg", url: "https://example.com/cat.jpg" }
            ],
            content: "What's in these images?",
            role: "user"
          }
        ],
        model: "openai/gpt-4o-mini"
      },
      undefined
    );
    const userMessage = wire.messages[0] as { content: Array<Record<string, unknown>> };
    expect(Array.isArray(userMessage.content)).toBe(true);
    expect(userMessage.content[0]).toMatchObject({ text: "What's in these images?", type: "text" });
    expect(userMessage.content[1]).toMatchObject({
      image_url: { url: "data:image/png;base64,BASE64DATA" },
      type: "image_url"
    });
    expect(userMessage.content[2]).toMatchObject({
      image_url: { url: "https://example.com/cat.jpg" },
      type: "image_url"
    });
  });

  it("leaves messages WITHOUT attachments as plain string content", () => {
    const wire = toOpenAIChatRequest(
      {
        messages: [{ content: "hello", role: "user" }],
        model: "openai/gpt-4o-mini"
      },
      undefined
    );
    expect(typeof (wire.messages[0] as { content: unknown }).content).toBe("string");
  });
});

describe("toGeminiRequest with attachments (phase B)", () => {
  it("uses inlineData for base64 attachments and fileData for URL refs", () => {
    const wire = toGeminiRequest({
      messages: [
        {
          attachments: [
            { dataBase64: "BASE64DATA", mimeType: "image/png" },
            { mimeType: "image/jpeg", url: "https://example.com/cat.jpg" }
          ],
          content: "Describe these.",
          role: "user"
        }
      ],
      model: "gemini-2.0-flash"
    });
    const contents = wire.contents as Array<{ parts: Array<Record<string, unknown>>; role: string }>;
    expect(contents).toHaveLength(1);
    expect(contents[0]?.role).toBe("user");
    expect(contents[0]?.parts[0]).toMatchObject({ text: "Describe these." });
    expect(contents[0]?.parts[1]).toMatchObject({
      inlineData: { data: "BASE64DATA", mimeType: "image/png" }
    });
    expect(contents[0]?.parts[2]).toMatchObject({
      fileData: { fileUri: "https://example.com/cat.jpg", mimeType: "image/jpeg" }
    });
  });

  it("preserves legacy single-text-part shape when no attachments", () => {
    const wire = toGeminiRequest({
      messages: [{ content: "hello", role: "user" }],
      model: "gemini-2.0-flash"
    });
    const contents = wire.contents as Array<{ parts: Array<Record<string, unknown>>; role: string }>;
    expect(contents[0]?.parts).toEqual([{ text: "hello" }]);
  });
});
