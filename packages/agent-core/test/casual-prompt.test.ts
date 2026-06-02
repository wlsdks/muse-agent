import { describe, expect, it } from "vitest";

import { classifyCasualPrompt, classifyMetaPrompt } from "../src/index.js";

describe("classifyCasualPrompt — pure social prompts only (precision-first)", () => {
  it("classifies greetings (EN + KO), tolerating trailing punctuation and repeats", () => {
    for (const q of ["hi", "Hi!", "hello", "hey there", "HELLO", "hiii", "안녕", "안녕하세요", "good morning", "hey muse"]) {
      expect(classifyCasualPrompt(q)).toBe("greeting");
    }
  });

  it("classifies thanks (EN + KO)", () => {
    for (const q of ["thanks", "Thank you", "thx", "ty", "고마워", "감사합니다", "appreciate it"]) {
      expect(classifyCasualPrompt(q)).toBe("thanks");
    }
  });

  it("classifies farewells (EN + KO)", () => {
    for (const q of ["bye", "goodbye", "see you", "take care", "잘가", "안녕히 계세요"]) {
      expect(classifyCasualPrompt(q)).toBe("farewell");
    }
  });

  it("returns null for a real question — even when it OPENS with a social word", () => {
    for (const q of [
      "what is my monthly rent?",
      "hi, what's my MTU?",
      "thanks — when is the dentist cleaning?",
      "hello world program in rust",
      "who is my landlord",
      "bye-bye script: what does it do?",
      "thank you note template for the wedding"
    ]) {
      expect(classifyCasualPrompt(q)).toBeNull();
    }
  });

  it("returns null for empty / whitespace input", () => {
    expect(classifyCasualPrompt("")).toBeNull();
    expect(classifyCasualPrompt("   ")).toBeNull();
  });

  it("never misclassifies a long prompt as casual (the 30-char content guard)", () => {
    expect(classifyCasualPrompt("hello, could you summarise my meeting notes from yesterday")).toBeNull();
  });
});

describe("classifyMetaPrompt — questions ABOUT Muse itself (precision-first)", () => {
  it("matches self-referential capability / identity / usage questions (EN + KO)", () => {
    for (const q of [
      "what can you do?", "what can you do", "what do you do", "what are you",
      "who are you?", "what is muse", "how do you work?", "how does this work",
      "what can I ask", "help", "넌 뭐야?", "뭐 할 수 있어", "어떻게 작동해", "사용법"
    ]) {
      expect(classifyMetaPrompt(q)).toBe(true);
    }
  });

  it("does NOT match a question about the user's notes that merely contains a meta word", () => {
    for (const q of [
      "what can you do about my taxes?",
      "how do you make sourdough",
      "what are you working on in the migration plan",
      "who are the attendees in the Q3 meeting",
      "what is my rent"
    ]) {
      expect(classifyMetaPrompt(q)).toBe(false);
    }
  });
});
