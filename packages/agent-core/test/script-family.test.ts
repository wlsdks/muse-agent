import { describe, expect, it } from "vitest";

import { comparableScript, dominantScriptFamily } from "../src/script-family.js";

describe("dominantScriptFamily", () => {
  it("classifies pure scripts", () => {
    expect(dominantScriptFamily("prefers bullet points")).toBe("latin");
    expect(dominantScriptFamily("짧게 핵심만 정리해줘")).toBe("hangul");
    expect(dominantScriptFamily("もっと短くして")).toBe("kana"); // kana outnumbers the single kanji
    expect(dominantScriptFamily("简短的回答")).toBe("han");
    expect(dominantScriptFamily("123 !!! ✨")).toBe("none");
  });

  it("uses the DOMINANT script, not mere presence — a Latin loanword in Korean stays Hangul", () => {
    expect(dominantScriptFamily("JSON 형식으로 답해줘")).toBe("hangul");
    expect(dominantScriptFamily("PDF 파일로 저장해")).toBe("hangul");
  });
});

describe("comparableScript", () => {
  it("same dominant family → comparable", () => {
    expect(comparableScript("prefers bullets", "prefers concise answers")).toBe(true);
    expect(comparableScript("짧게 답해", "간결하게 핵심만")).toBe(true);
  });

  it("different families → NOT comparable (gate must skip the cosine test)", () => {
    expect(comparableScript("짧게 핵심만 정리해줘", "prefers concise answers")).toBe(false);
    expect(comparableScript("JSON 형식으로 답해줘", "prefers JSON formatted output")).toBe(false);
    expect(comparableScript("もっと短くして", "prefers brevity")).toBe(false);
  });

  it("an unscripted string is comparable to nothing", () => {
    expect(comparableScript("123 !!!", "prefers bullets")).toBe(false);
    expect(comparableScript("123", "456")).toBe(false);
  });
});
