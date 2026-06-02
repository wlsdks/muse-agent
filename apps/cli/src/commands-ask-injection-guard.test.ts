import { describe, expect, it } from "vitest";

import { CITATION_INSTRUCTION_LINES } from "./commands-ask.js";

// The injection-input-guard scans the WHOLE composed agent prompt (system role
// included). "copy an existing `cite as:` token, or a name shown…" once matched
// the `credential_extraction` pattern ("token … shown") and false-blocked EVERY
// grounded `muse ask --with-tools` query. These guards keep Muse's own prompt
// from self-triggering it again.
describe("CITATION_INSTRUCTION_LINES — must never self-trigger the injection guard", () => {
  it("carries no credential word near an extraction verb (token/secret/password/…)", () => {
    const joined = CITATION_INSTRUCTION_LINES.join(" ").toLowerCase();
    for (const word of ["token", "secret", "password", "api key", "비밀번호", "암호", "토큰"]) {
      expect(joined).not.toContain(word);
    }
  });

  it("still instructs verbatim citation from a marker (the fix preserved the grounding contract)", () => {
    const joined = CITATION_INSTRUCTION_LINES.join(" ");
    expect(joined).toMatch(/cite as:/u);
    expect(joined).toMatch(/VERBATIM/u);
    expect(joined).toMatch(/NEVER invent/u);
  });
});
