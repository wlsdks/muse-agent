import assert from "node:assert/strict";
import { test } from "node:test";

import { lineAssertsIdentity, lineCallsBuildSystemPrompt } from "./lib/prompt-seam-patterns.mjs";

// The drift lint used to guard the single-source-identity invariant with only
// two EXACT literals (/You are Muse/, /너는 뮤즈/), so any paraphrased identity
// string outside the seam passed untouched (audit finding). These assert the
// broadened matcher catches the paraphrases a real drift would use, in BOTH
// directions (flags the leak, leaves benign Muse mentions alone).

test("flags paraphrased identity self-assertions the old 2-literal guard missed", () => {
  for (const s of [
    "I am Muse.",
    "I'm Muse, your personal agent.",
    "You're Muse",
    "저는 뮤즈입니다",
    "나는 뮤즈야",
    "제 이름은 뮤즈예요",
    "내 이름은 뮤즈"
  ]) {
    assert.ok(lineAssertsIdentity(s), `should flag paraphrase: ${s}`);
  }
});

test("still flags the original two literals (backward compatible)", () => {
  assert.ok(lineAssertsIdentity("You are Muse, a model-agnostic agent runtime."));
  assert.ok(lineAssertsIdentity("너는 뮤즈다"));
});

test("does NOT flag benign, non-identity-binding Muse mentions", () => {
  for (const s of [
    "Muse is a local-first personal agent.",
    "using the Muse runtime",
    "// route identity through @muse/prompts composeSurfacePrompt",
    "the Muse project ships adapters",
    'import { composeSurfacePrompt } from "@muse/prompts";',
    "you are musing about the design",
    "muse-agent monorepo"
  ]) {
    assert.ok(!lineAssertsIdentity(s), `should NOT flag benign mention: ${s}`);
  }
});

test("flags a direct buildSystemPrompt( call, not composeSurfacePrompt", () => {
  assert.ok(lineCallsBuildSystemPrompt("const p = buildSystemPrompt({ basePrompt });"));
  assert.ok(!lineCallsBuildSystemPrompt("const p = composeSurfacePrompt('chat', {});"));
});
