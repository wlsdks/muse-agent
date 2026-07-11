import { describe, expect, it } from "vitest";

import { composeIdentityPrompt, MUSE_IDENTITY_CORE } from "../src/identity-core.js";

describe("MUSE_IDENTITY_CORE", () => {
  it("names Muse in both Korean and English", () => {
    expect(MUSE_IDENTITY_CORE).toContain("뮤즈");
    expect(MUSE_IDENTITY_CORE).toContain("Muse");
  });

  it("states the local, on-device data guarantee", () => {
    expect(MUSE_IDENTITY_CORE).toContain("로컬");
    expect(MUSE_IDENTITY_CORE).toMatch(/locally|이 기기/u);
  });

  it("carries the motto verbatim", () => {
    expect(MUSE_IDENTITY_CORE).toContain("Learns you, not the world");
  });

  it("attributes creation to the user, never a vendor", () => {
    expect(MUSE_IDENTITY_CORE).toMatch(/사용자.*만들|만든 건 사용자/u);
    expect(MUSE_IDENTITY_CORE).not.toMatch(/구글이 만들었|Google (created|made) (you|Muse)/u);
  });

  it("names the local engine honestly without adopting the vendor identity", () => {
    expect(MUSE_IDENTITY_CORE).toMatch(/엔진일 뿐/u);
    expect(MUSE_IDENTITY_CORE).toContain("Gemma");
    expect(MUSE_IDENTITY_CORE).toContain("Ollama");
  });

  it("forbids claiming a vendor identity or having no name", () => {
    expect(MUSE_IDENTITY_CORE).toMatch(/구글\/OpenAI/u);
    expect(MUSE_IDENTITY_CORE).toMatch(/이름이 없는/u);
    expect(MUSE_IDENTITY_CORE).toMatch(/no name/u);
  });

  it("sets a Korean-first, firm-not-sycophantic tone", () => {
    expect(MUSE_IDENTITY_CORE).toContain("한국어");
    expect(MUSE_IDENTITY_CORE).toMatch(/정정하라|correct/u);
  });

  it("stays compact — at most 14 lines", () => {
    expect(MUSE_IDENTITY_CORE.split("\n").length).toBeLessThanOrEqual(14);
  });

  it("contains no grounding-fence marker tokens that could confuse the injection scanner", () => {
    expect(MUSE_IDENTITY_CORE).not.toMatch(/<<|>>|\[from /u);
  });
});

describe("composeIdentityPrompt", () => {
  it("returns the identity core alone when no role suffix is given", () => {
    expect(composeIdentityPrompt()).toBe(MUSE_IDENTITY_CORE);
    expect(composeIdentityPrompt("   ")).toBe(MUSE_IDENTITY_CORE);
  });

  it("prepends the identity core to a role-specific suffix, blank-line separated", () => {
    const out = composeIdentityPrompt("Render the briefing as one short paragraph.");
    expect(out.startsWith(MUSE_IDENTITY_CORE)).toBe(true);
    expect(out).toBe(`${MUSE_IDENTITY_CORE}\n\nRender the briefing as one short paragraph.`);
  });

  it("trims the role suffix", () => {
    expect(composeIdentityPrompt("  role text  ")).toBe(`${MUSE_IDENTITY_CORE}\n\nrole text`);
  });
});

describe("identity core does not force a 존댓말 self-intro onto every turn", () => {
  it("scopes the name-first rule to questions ABOUT Muse, not every answer", () => {
    // The live probe found the model prefixing "저는 뮤즈(Muse)예요" to
    // unrelated casual turns ("밥 뭐 먹을까?") and forcing a 존댓말 intro
    // into 반말 turns — the register-mirroring layer could not win against
    // an unconditional 존댓말 template.
    expect(MUSE_IDENTITY_CORE).not.toContain("자신에 대해 답할 때는 항상 먼저");
    expect(MUSE_IDENTITY_CORE).toMatch(/너에 대해 물으면|정체성.*질문|누가 만들었는지/u);
    expect(MUSE_IDENTITY_CORE).toMatch(/그 외의 일반 질문에는 자기소개를 붙이지 말고/u);
  });

  it("still anchors the name and the never-claim rules", () => {
    expect(MUSE_IDENTITY_CORE).toContain("뮤즈");
    expect(MUSE_IDENTITY_CORE).toContain("Muse");
    expect(MUSE_IDENTITY_CORE).toMatch(/구글|Google/u);
  });

  it("tells the model to match the user's register in its self-answer too", () => {
    expect(MUSE_IDENTITY_CORE).toMatch(/반말이면|사용자의 말투에 맞춰/u);
  });
});
