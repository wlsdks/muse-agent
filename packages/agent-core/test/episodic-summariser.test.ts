import { describe, expect, it, vi } from "vitest";

import {
  extractCurrentSessionTurns,
  redactSecrets,
  summariseSession,
  type SessionBoundaryRef,
  type SessionTurnLine
} from "../src/episodic-summariser.js";
import type { ModelProvider } from "@muse/model";

function stubProvider(generated: { readonly output: string } | Error): ModelProvider {
  return {
    id: "stub",
    listModels: async () => [],
    generate: async () => {
      if (generated instanceof Error) throw generated;
      return {
        id: "stub-resp",
        model: "stub",
        output: generated.output
      };
    },
    stream: async function* () { /* not used */ }
  };
}

describe("extractCurrentSessionTurns", () => {
  it("returns undefined when no boundaries have been written", () => {
    const lines: SessionTurnLine[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ];
    expect(extractCurrentSessionTurns(lines, [])).toBeUndefined();
  });

  it("returns undefined when the current session has no turns", () => {
    const boundaries: SessionBoundaryRef[] = [{ tsIso: "2026-05-13T08:00:00Z" }];
    expect(extractCurrentSessionTurns([], boundaries)).toBeUndefined();
  });

  it("uses the latest boundary's tsIso as startedAt and carries userId when present", () => {
    const lines: SessionTurnLine[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "later" },
      { role: "assistant", content: "later reply" }
    ];
    const boundaries: SessionBoundaryRef[] = [
      { tsIso: "2026-05-12T22:00:00Z", userId: "stark" },
      { tsIso: "2026-05-13T08:00:00Z", userId: "stark" }
    ];
    const range = extractCurrentSessionTurns(lines, boundaries);
    expect(range).toBeDefined();
    expect(range!.startedAt).toBe("2026-05-13T08:00:00Z");
    expect(range!.userId).toBe("stark");
    expect(range!.turns).toHaveLength(4);
  });
});

describe("redactSecrets", () => {
  it("scrubs OpenAI / GitHub / Google / Anthropic secret shapes", () => {
    const input = [
      "OpenAI: sk-abc123XYZ_DEF-456",
      "Anthropic: sk-ant-api03-XYZ.shortKey",
      "GitHub: ghp_ABCDEF1234567890abc",
      "Google: AIzaSyA1B2C3D4E5F6G7H8I9J0KLMNO",
      "OAuth token: ya29.A0AbCdEfGhIjKlMnOpQrStUvWxYz",
      "Innocent text stays put"
    ].join(" | ");
    const redacted = redactSecrets(input);
    expect(redacted).not.toContain("sk-abc");
    expect(redacted).not.toContain("sk-ant-api03");
    expect(redacted).not.toContain("ghp_ABCDEF");
    expect(redacted).not.toContain("AIzaSy");
    expect(redacted).not.toContain("ya29.A0");
    expect(redacted).toContain("Innocent text stays put");
    expect(redacted).toContain("<redacted-secret>");
  });

  it("leaves text without secret shapes unchanged", () => {
    const clean = "I'd like to talk about Q3 budget. Notion link: docs.notion/page";
    expect(redactSecrets(clean)).toBe(clean);
  });
});

describe("summariseSession", () => {
  it("returns undefined for an empty turn list without calling the model", async () => {
    const provider = stubProvider({ output: "should not run" });
    const generateSpy = vi.spyOn(provider, "generate");
    const result = await summariseSession({
      model: "gemini-2.0-flash",
      modelProvider: provider,
      turns: []
    });
    expect(result).toBeUndefined();
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("parses the canonical 'paragraph + topics:' shape into structured summary", async () => {
    const provider = stubProvider({
      output: "Discussed the Q3 budget memo. User decided to draft it in Notion by Friday. Open question: who reviews?\ntopics: Q3 budget memo, Notion drafting"
    });
    const result = await summariseSession({
      model: "gemini-2.0-flash",
      modelProvider: provider,
      turns: [
        { role: "user", content: "Let's plan the Q3 memo" },
        { role: "assistant", content: "Sure — Notion seems good" }
      ]
    });
    expect(result).toEqual({
      summary: "Discussed the Q3 budget memo. User decided to draft it in Notion by Friday. Open question: who reviews?",
      topics: ["Q3 budget memo", "Notion drafting"]
    });
  });

  it("tolerates output without a topics: section", async () => {
    const provider = stubProvider({
      output: "Quick chat about lunch options; no decision made."
    });
    const result = await summariseSession({
      model: "stub",
      modelProvider: provider,
      turns: [
        { role: "user", content: "Where for lunch?" },
        { role: "assistant", content: "Up to you" }
      ]
    });
    expect(result).toEqual({
      summary: "Quick chat about lunch options; no decision made.",
      topics: []
    });
  });

  it("uses the LAST `topics:` line when the model restates it (no early truncation)", async () => {
    const provider = stubProvider({
      output: [
        "Discussed the deploy plan.",
        "topics: deploy",
        "The user then set Friday as the deadline.",
        "topics: deploy plan, Friday deadline"
      ].join("\n")
    });
    const result = await summariseSession({
      model: "stub",
      modelProvider: provider,
      turns: [
        { role: "user", content: "plan the deploy" },
        { role: "assistant", content: "ok" }
      ]
    });
    // Body keeps everything up to the LAST topics: line (not
    // truncated at the first), topics come from the last line.
    expect(result?.summary).toContain("The user then set Friday as the deadline.");
    expect(result?.topics).toEqual(["deploy plan", "Friday deadline"]);
  });

  it("fails soft (returns undefined) on model error and on empty output", async () => {
    const onError = await summariseSession({
      model: "stub",
      modelProvider: stubProvider(new Error("network down")),
      turns: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }]
    });
    expect(onError).toBeUndefined();

    const onEmpty = await summariseSession({
      model: "stub",
      modelProvider: stubProvider({ output: "   " }),
      turns: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }]
    });
    expect(onEmpty).toBeUndefined();
  });

  it("redacts secrets in the transcript before sending to the model", async () => {
    let seenUserMessage = "";
    const provider: ModelProvider = {
      id: "spy",
      listModels: async () => [],
      generate: async (request) => {
        const userMsg = request.messages.find((m) => m.role === "user");
        seenUserMessage = userMsg?.content ?? "";
        return {
          id: "spy-resp",
          model: "spy",
          output: "Summary here.\ntopics: secret-handling"
        };
      },
      stream: async function* () { /* not used */ }
    };
    await summariseSession({
      model: "spy",
      modelProvider: provider,
      turns: [
        { role: "user", content: "My OpenAI key is sk-leak1234567890ABCDEF" },
        { role: "assistant", content: "Got it" }
      ]
    });
    expect(seenUserMessage).not.toContain("sk-leak");
    expect(seenUserMessage).toContain("<redacted-secret>");
  });
});
