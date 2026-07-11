import { describe, expect, it } from "vitest";

import { casualResponseFor, classifyCasualPrompt, containsHangul, type CasualPromptKind } from "../src/index.js";

describe("casualResponseFor — the shared canned reply for a classified casual kind", () => {
  it("returns a non-empty reply for every kind classifyCasualPrompt can produce", () => {
    for (const q of ["hi", "thanks", "bye"]) {
      const kind = classifyCasualPrompt(q);
      expect(kind).not.toBeNull();
      expect(casualResponseFor(kind as CasualPromptKind)).toBeTruthy();
    }
  });

  it("carries no citation-like token — the whole point is to skip the grounding machinery", () => {
    for (const kind of ["greeting", "thanks", "farewell"] as const) {
      expect(casualResponseFor(kind)).not.toMatch(/\[(from|action|event|task|reminder|contact|command|session|feed)\b/u);
    }
  });
});

describe("casualResponseFor — Korean reply for a Korean input (language parity)", () => {
  it("returns a distinct Korean reply for each kind when korean=true", () => {
    for (const kind of ["greeting", "thanks", "farewell"] as const) {
      const en = casualResponseFor(kind);
      const ko = casualResponseFor(kind, true);
      expect(ko).not.toBe(en);
      expect(containsHangul(ko)).toBe(true);
    }
  });

  it("carries no citation-like token in the Korean replies either", () => {
    for (const kind of ["greeting", "thanks", "farewell"] as const) {
      expect(casualResponseFor(kind, true)).not.toMatch(/\[(from|action|event|task|reminder|contact|command|session|feed)\b/u);
    }
  });

  it("defaults to the existing EN reply, byte-for-byte, when korean is omitted or false", () => {
    for (const kind of ["greeting", "thanks", "farewell"] as const) {
      expect(casualResponseFor(kind, false)).toBe(casualResponseFor(kind));
    }
  });
});

describe("containsHangul — the deterministic KO-input signal driving the reply language", () => {
  it("true only when the text contains a Hangul syllable", () => {
    expect(containsHangul("안녕")).toBe(true);
    expect(containsHangul("hi 안녕")).toBe(true);
    expect(containsHangul("hi")).toBe(false);
    expect(containsHangul("")).toBe(false);
  });
});
