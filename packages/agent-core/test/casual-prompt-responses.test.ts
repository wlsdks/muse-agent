import { describe, expect, it } from "vitest";

import { casualResponseFor, classifyCasualPrompt, type CasualPromptKind } from "../src/index.js";

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
