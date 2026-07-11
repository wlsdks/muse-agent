import { describe, expect, it } from "vitest";

import { tryDeterministicAnswer } from "./ask-fast-paths.js";

// Language parity for the casual fast-path: classifyCasualPrompt already
// matches Korean greeting/thanks/farewell phrases, but the reply text was
// hard-coded English, so a Korean "안녕~" got an English answer back. The
// INPUT text decides the reply language — deterministic, no model call.
describe("tryDeterministicAnswer casual fast-path — KO input gets a KO reply, EN input is byte-unchanged", () => {
  it("answers a Korean greeting/thanks/farewell in Korean", () => {
    for (const query of ["안녕~", "고마워", "잘자"]) {
      const hit = tryDeterministicAnswer(query, {});
      expect(hit, query).not.toBeNull();
      expect(hit?.answer, query).toMatch(/[가-힣]/u);
    }
  });

  it("still answers an English greeting with the exact unchanged EN string", () => {
    const hit = tryDeterministicAnswer("hi", {});
    expect(hit?.answer).toBe(
      "Hi! I answer from your own notes — ask me anything you've saved and I'll quote the source, or tell you honestly when it isn't there."
    );
  });

  it("a mixed KO+EN casual utterance still resolves to a Korean reply — Korean wins", () => {
    const hit = tryDeterministicAnswer("안녕 there", {});
    expect(hit).not.toBeNull();
    expect(hit?.jsonPayload.casual).toBe("greeting");
    expect(hit?.answer).toMatch(/[가-힣]/u);
  });

  it("the JSON payload's answer field matches the text answer for a KO casual hit", () => {
    const hit = tryDeterministicAnswer("안녕~", {});
    expect(hit?.jsonPayload.answer).toBe(hit?.answer);
  });
});
