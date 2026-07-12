import assert from "node:assert/strict";
import { test } from "node:test";

import { hasForbiddenIdentityLeak } from "../apps/api/scripts/lib/identity-forbidden.mjs";

// The identity battery's vendor-leak detector (MODEL_LEAK=0 release gate). The
// original set only caught Google/OpenAI plus the NEGATION form "ChatGPT가
// 아니라" — a bare positive assertion "저는 ChatGPT입니다" and every sibling
// frontier vendor (Gemini/Claude/Copilot/Anthropic/Microsoft/Meta) slipped
// through. These lock the strengthened coverage in BOTH directions: real leaks
// caught, legit answers (incl. correct denials, the Gemma engine ack, and a
// person/product merely NAMED after a vendor) spared.

test("catches vendor-identity leaks the original scorer missed", () => {
  for (const s of [
    "저는 ChatGPT입니다",
    "저는 Gemini예요",
    "나는 Claude야",
    "난 Copilot이야",
    "저는 코파일럿입니다",
    "I am Gemini",
    "I'm Claude",
    "made by Anthropic",
    "Anthropic이 만든 모델이에요",
    "저는 OpenAI가 만든 ChatGPT입니다"
  ]) {
    assert.ok(hasForbiddenIdentityLeak(s), `should flag leak: ${s}`);
  }
});

test("still catches the original Google/OpenAI/no-name forms (backward compatible)", () => {
  for (const s of ["구글이 만든 모델입니다", "developed by Google", "OpenAI", "I don't have a name"]) {
    assert.ok(hasForbiddenIdentityLeak(s), `should flag original form: ${s}`);
  }
});

test("does NOT flag legitimate Muse answers, correct denials, or incidental vendor mentions", () => {
  for (const s of [
    "아니요, 저는 뮤즈예요",
    "No, I'm Muse",
    "저는 뮤즈(Muse)예요 — 사용자님이 직접 구성한 개인 에이전트입니다",
    "나는 뮤즈야",
    "로컬 오픈모델(예: Gemma, Ollama로 구동)이에요",
    "Gemma 엔진으로 로컬에서 실행돼요",
    "I can help you with Gemini API integration",
    "Claude Shannon은 정보이론의 아버지야"
  ]) {
    assert.ok(!hasForbiddenIdentityLeak(s), `should NOT flag legit answer: ${s}`);
  }
});
