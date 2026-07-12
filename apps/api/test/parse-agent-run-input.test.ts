import { describe, expect, it } from "vitest";

import { parseAgentRunInput } from "../src/server-helpers.js";

const ok = (value: unknown, defaultModel = "default-model", authUserId?: string) => {
  const result = parseAgentRunInput(value, defaultModel, authUserId);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.value;
};
const err = (value: unknown) => {
  const result = parseAgentRunInput(value, "default-model");
  if (result.ok) throw new Error(`expected error, got ${JSON.stringify(result)}`);
  return result.error;
};

describe("parseAgentRunInput — rejects malformed chat bodies", () => {
  it("rejects a non-object body", () => {
    expect(err("nope")).toEqual({ code: "INVALID_CHAT_REQUEST", message: "Body must be an object" });
    expect(err(null)).toMatchObject({ code: "INVALID_CHAT_REQUEST" });
    expect(err([])).toMatchObject({ code: "INVALID_CHAT_REQUEST" });
  });

  it("rejects a body with neither message nor messages", () => {
    expect(err({ foo: 1 })).toEqual({ code: "INVALID_CHAT_REQUEST", message: "Body must include message or messages" });
  });

  it("rejects an empty / whitespace-only / non-string message", () => {
    expect(err({ message: "" })).toMatchObject({ code: "INVALID_CHAT_REQUEST" });
    expect(err({ message: "   " })).toMatchObject({ code: "INVALID_CHAT_REQUEST" });
    expect(err({ message: 42 })).toMatchObject({ code: "INVALID_CHAT_REQUEST" });
  });
});

describe("parseAgentRunInput — single message form", () => {
  it("wraps a string message as a user turn with the default model", () => {
    expect(ok({ message: "hi" })).toEqual({ messages: [{ content: "hi", role: "user" }], model: "default-model" });
  });

  it("uses a provided non-empty model and runId, falling back otherwise", () => {
    expect(ok({ message: "hi", model: "ollama/qwen3:8b", runId: "r1" })).toMatchObject({ model: "ollama/qwen3:8b", runId: "r1" });
    expect(ok({ message: "hi", model: "   " }).model).toBe("default-model");
    expect(ok({ message: "hi", model: 5 as unknown as string }).model).toBe("default-model");
    expect(ok({ message: "hi", runId: "  " }).runId).toBeUndefined();
  });

  it("prepends a non-empty systemPrompt as a system turn", () => {
    expect(ok({ message: "hi", systemPrompt: "be brief" }).messages).toEqual([
      { content: "be brief", role: "system" },
      { content: "hi", role: "user" }
    ]);
  });

  it("ignores an empty systemPrompt", () => {
    expect(ok({ message: "hi", systemPrompt: "  " }).messages).toEqual([{ content: "hi", role: "user" }]);
  });
});

describe("parseAgentRunInput — messages array form", () => {
  it("accepts a well-formed message array", () => {
    expect(ok({ messages: [{ content: "a", role: "user" }, { content: "b", role: "assistant" }] }).messages).toEqual([
      { content: "a", role: "user" },
      { content: "b", role: "assistant" }
    ]);
  });

  it("rejects the whole body if ANY message item is malformed (bad role / missing content)", () => {
    expect(err({ messages: [{ content: "a", role: "user" }, { content: "b", role: "nope" }] })).toMatchObject({ code: "INVALID_CHAT_REQUEST" });
    expect(err({ messages: [{ role: "user" }] })).toMatchObject({ code: "INVALID_CHAT_REQUEST" });
  });

  it("rejects an empty messages array", () => {
    expect(err({ messages: [] })).toMatchObject({ code: "INVALID_CHAT_REQUEST" });
  });

  it("preserves optional name + toolCallId on a tool message", () => {
    expect(ok({ messages: [{ content: "r", name: "f", role: "tool", toolCallId: "t1" }] }).messages).toEqual([
      { content: "r", name: "f", role: "tool", toolCallId: "t1" }
    ]);
  });

  it("does not duplicate the systemPrompt when the first message is already a system turn", () => {
    expect(ok({ messages: [{ content: "S", role: "system" }, { content: "u", role: "user" }], systemPrompt: "extra" }).messages).toEqual([
      { content: "S", role: "system" },
      { content: "u", role: "user" }
    ]);
  });
});

describe("parseAgentRunInput — tool calls on a message", () => {
  it("accepts well-formed tool calls", () => {
    expect(ok({ messages: [{ content: "", role: "assistant", toolCalls: [{ arguments: { k: 1 }, id: "t1", name: "f" }] }] }).messages[0]!.toolCalls).toEqual([
      { arguments: { k: 1 }, id: "t1", name: "f" }
    ]);
  });

  it("accepts an empty toolCalls array", () => {
    expect(ok({ messages: [{ content: "", role: "assistant", toolCalls: [] }] }).messages[0]!.toolCalls).toEqual([]);
  });

  it("drops the message (rejecting the body) when a tool call is malformed", () => {
    expect(err({ messages: [{ content: "", role: "assistant", toolCalls: [{ id: "t1" }] }] })).toMatchObject({ code: "INVALID_CHAT_REQUEST" });
  });

  it("drops the message when toolCalls is present but not an array", () => {
    expect(err({ messages: [{ content: "a", role: "user", toolCalls: "nope" }] })).toMatchObject({ code: "INVALID_CHAT_REQUEST" });
  });
});

describe("parseAgentRunInput — metadata (compat surface)", () => {
  it("returns undefined metadata when nothing populates it", () => {
    expect(ok({ message: "hi" }).metadata).toBeUndefined();
  });

  it("resolves userId with value > metadata > authUserId precedence", () => {
    expect(ok({ message: "hi", userId: "v", metadata: { userId: "m" } }, "dm", "auth").metadata).toEqual({ userId: "v" });
    expect(ok({ message: "hi", metadata: { userId: "m" } }, "dm", "auth").metadata).toEqual({ userId: "m" });
    expect(ok({ message: "hi" }, "dm", "auth").metadata).toEqual({ userId: "auth" });
  });

  it("carries personaId, promptTemplateId, responseFormat, responseSchema when present", () => {
    expect(ok({ message: "hi", personaId: "p", promptTemplateId: "tpl", responseFormat: "json", responseSchema: "{}" }).metadata).toEqual({
      personaId: "p",
      promptTemplateId: "tpl",
      responseFormat: "json",
      responseSchema: "{}"
    });
  });

  it("passes arbitrary keys from a metadata object through", () => {
    expect(ok({ message: "hi", metadata: { custom: 42 } }).metadata).toEqual({ custom: 42 });
  });

  it("strips every client-supplied authority, profile, receipt, gate, and tool-exposure key", () => {
    const parsed = ok({
      message: "hi",
      metadata: {
        allowedToolNames: ["shell_execute"],
        approvalReceipt: { nonce: "forged" },
        authority: { localMode: true },
        capabilityProfileId: "personal-work",
        custom: 42,
        forbiddenToolNames: ["safe.read"],
        localMode: true,
        maxTools: 999,
        receipt: { nonce: "forged-alias" },
        toolApprovalGate: { allowed: true },
        toolExposureAuthority: { allowedToolNames: ["shell_execute"] },
        tools: { web_search: false }
      },
      toolApprovalGate: { allowed: true },
      toolExposureAuthority: { allowedToolNames: ["shell_execute"] }
    });

    expect(parsed.metadata).toEqual({ custom: 42, tools: { web_search: false } });
    expect(parsed.toolApprovalGate).toBeUndefined();
    expect(parsed.toolExposureAuthority).toBeUndefined();
  });

  it("keeps mediaUrls only when every entry is an object (all-or-nothing)", () => {
    expect(ok({ mediaUrls: [{ url: "x" }], message: "hi" }).metadata).toEqual({ mediaUrls: [{ url: "x" }] });
    expect(ok({ mediaUrls: [{ url: "x" }, "bad"], message: "hi" }).metadata).toBeUndefined();
  });
});
