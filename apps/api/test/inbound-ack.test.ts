import { describe, expect, it } from "vitest";

import { createComposeAck, sanitizeAckText } from "../src/inbound-ack.js";

describe("sanitizeAckText", () => {
  it("trims and collapses internal newlines to a single space", () => {
    expect(sanitizeAckText("  got it\n\nI'll let you know  ")).toBe("got it I'll let you know");
  });

  it("rejects an empty (or whitespace-only) result", () => {
    expect(sanitizeAckText("   ")).toBeNull();
    expect(sanitizeAckText("")).toBeNull();
  });

  it("rejects text over the 200-char cap", () => {
    expect(sanitizeAckText("a".repeat(200))).toBe("a".repeat(200));
    expect(sanitizeAckText("a".repeat(201))).toBeNull();
  });

  it("rejects a structured colon-style citation marker — an ack is not a factual claim", () => {
    expect(sanitizeAckText("On it [note:123].")).toBeNull();
    expect(sanitizeAckText("On it [web:example.com].")).toBeNull();
  });

  it("rejects Muse's real production note-verb citation form — an ack is not a factual claim", () => {
    expect(sanitizeAckText("On it [from notes/rent.md].")).toBeNull();
    expect(sanitizeAckText("On it [from vpn-setup].")).toBeNull();
  });

  it("passes plain restatement text through unchanged (after trim)", () => {
    expect(sanitizeAckText("Got it — I'll check your calendar and report back.")).toBe(
      "Got it — I'll check your calendar and report back."
    );
  });
});

describe("createComposeAck", () => {
  it("returns the sanitized model output on a normal call", async () => {
    const composeAck = createComposeAck({
      model: "gemma4:12b",
      modelProvider: {
        generate: async () => ({ id: "1", model: "gemma4:12b", output: "On it — I'll report back." })
      }
    });

    expect(await composeAck({ latestUserText: "what's on my calendar tomorrow?" })).toBe(
      "On it — I'll report back."
    );
  });

  it("returns null when the model errors", async () => {
    const composeAck = createComposeAck({
      model: "gemma4:12b",
      modelProvider: {
        generate: async () => {
          throw new Error("model unavailable");
        }
      }
    });

    expect(await composeAck({ latestUserText: "what's on my calendar tomorrow?" })).toBeNull();
  });

  it("returns null when the model output fails the deterministic guard (e.g. a citation marker)", async () => {
    const composeAck = createComposeAck({
      model: "gemma4:12b",
      modelProvider: {
        generate: async () => ({ id: "1", model: "gemma4:12b", output: "On it [note:rent.md]." })
      }
    });

    expect(await composeAck({ latestUserText: "what's my rent?" })).toBeNull();
  });

  it("returns null on timeout, even if the model provider ignores the abort signal", async () => {
    const composeAck = createComposeAck({
      model: "gemma4:12b",
      modelProvider: {
        generate: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ id: "1", model: "gemma4:12b", output: "too slow" }), 50);
          })
      },
      timeoutMs: 5
    });

    expect(await composeAck({ latestUserText: "what's on my calendar tomorrow?" })).toBeNull();
  });

  it("returns null without calling the model for an empty user text", async () => {
    let called = false;
    const composeAck = createComposeAck({
      model: "gemma4:12b",
      modelProvider: {
        generate: async () => {
          called = true;
          return { id: "1", model: "gemma4:12b", output: "unused" };
        }
      }
    });

    expect(await composeAck({ latestUserText: "   " })).toBeNull();
    expect(called).toBe(false);
  });
});

// FIX B (register mirror): the ack's own default tone is casual ("like a
// quick text"), so without a register signal it can drift to 반말 even on a
// 존댓말 user turn — mismatching the full agent run's reply in the same
// conversation (that reply DOES mirror register). The system prompt must
// carry the SAME detected register `register-mirror.ts` computes.
describe("createComposeAck register mirror (FIX B)", () => {
  function captureSystemPrompt(): { readonly composeAck: ReturnType<typeof createComposeAck>; readonly prompts: string[] } {
    const prompts: string[] = [];
    const composeAck = createComposeAck({
      model: "gemma4:12b",
      modelProvider: {
        generate: async (request) => {
          prompts.push((request.messages[0]?.content as string) ?? "");
          return { id: "1", model: "gemma4:12b", output: "on it" };
        }
      }
    });
    return { composeAck, prompts };
  }

  it("존댓말 user turn → the system prompt names 존댓말", async () => {
    const { composeAck, prompts } = captureSystemPrompt();
    await composeAck({ latestUserText: "오늘 일정 알려주세요" });
    expect(prompts[0]).toContain("존댓말");
  });

  it("반말 user turn → the system prompt names 반말", async () => {
    const { composeAck, prompts } = captureSystemPrompt();
    await composeAck({ latestUserText: "오늘 일정 알려줘" });
    expect(prompts[0]).toContain("반말");
  });

  it("English turn → no register line added (nothing to mirror)", async () => {
    const { composeAck, prompts } = captureSystemPrompt();
    await composeAck({ latestUserText: "what's on my calendar tomorrow?" });
    expect(prompts[0]).not.toContain("존댓말");
    expect(prompts[0]).not.toContain("반말");
  });
});
