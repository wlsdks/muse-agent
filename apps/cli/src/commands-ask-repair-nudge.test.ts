import { describe, expect, it } from "vitest";

import { shouldSuggestRepair, suggestOptInSource } from "./commands-ask.js";

describe("shouldSuggestRepair — surface --repair only when it can actually help", () => {
  const base = { evidenceCount: 2, json: false, repairRequested: false, verdictFired: true };

  it("suggests it on an ungrounded answer with retrieved evidence and no --repair yet", () => {
    expect(shouldSuggestRepair(base)).toBe(true);
  });

  it("stays silent when the grounding verdict did NOT fire (a clean cited answer)", () => {
    expect(shouldSuggestRepair({ ...base, verdictFired: false })).toBe(false);
  });

  it("stays silent when --repair was already requested (it ran, no tip needed)", () => {
    expect(shouldSuggestRepair({ ...base, repairRequested: true })).toBe(false);
  });

  it("stays silent under --json (no prose tips in structured output)", () => {
    expect(shouldSuggestRepair({ ...base, json: true })).toBe(false);
  });

  it("stays silent with NO retrieved evidence — repair would just refuse, so the tip would mislead", () => {
    expect(shouldSuggestRepair({ ...base, evidenceCount: 0 })).toBe(false);
  });
});

describe("suggestOptInSource — make undiscoverable --git / --shell findable on a refusal", () => {
  const off = { git: false, shell: false };

  it("suggests --git for an unmistakable git question", () => {
    for (const q of ["what did I commit last week?", "what was that commit about auth?", "what's on my current branch", "what did I do in the git repo", "what changed in the codebase recently"]) {
      expect(suggestOptInSource(q, off), q).toContain("--git");
    }
  });

  it("suggests --shell for a command / terminal question", () => {
    for (const q of ["what was that docker command I ran?", "which kubectl command did I use", "what did I type in the terminal"]) {
      expect(suggestOptInSource(q, off), q).toContain("--shell");
    }
  });

  it("stays SILENT on a refusal with no git/shell intent (no spurious tip)", () => {
    for (const q of ["what is my car insurance number?", "when is my dentist appointment?", "what's my monthly rent", "who is my landlord"]) {
      expect(suggestOptInSource(q, off), q).toBeUndefined();
    }
  });

  it("does NOT re-suggest a flag that is already enabled", () => {
    expect(suggestOptInSource("what did I commit?", { git: true, shell: false })).toBeUndefined();
    expect(suggestOptInSource("what was that shell command?", { git: false, shell: true })).toBeUndefined();
  });
});
