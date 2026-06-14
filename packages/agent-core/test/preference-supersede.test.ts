import type { ModelRequest } from "@muse/model";
import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCE_SUPERSEDE_MAX, findSupersededPreferenceId } from "../src/index.js";

// Belief-revision supersession for inferred preferences (arXiv:2606.09483). A new
// preference that CONTRADICTS a stored DIFFERENT-category one escapes the by-category
// upsert and injects conflicting persona guidance — find it (model-polarity, not
// cosine: same-topic opposite-polarity prefs have HIGH cosine) so the caller drops it.

// Stub the polarity model: CONTRADICT only when the stored "bullet points" rule is
// pitted against the new "flowing prose" preference; everything else UNRELATED.
const polarityProvider = (verdict: (rulePrompt: string) => string) => ({
  generate: async (req: ModelRequest) => {
    const userMsg = req.messages.find((m) => m.role === "user")?.content ?? "";
    return { id: "r", model: "m", output: verdict(userMsg) };
  }
});
const opts = (verdict: (p: string) => string) => ({ model: "m", modelProvider: polarityProvider(verdict) });

describe("findSupersededPreferenceId (arXiv:2606.09483)", () => {
  const existing = [
    { id: "pref-format", value: "always answer in bullet points" },
    { id: "pref-language", value: "reply in Korean" }
  ];

  it("returns the id of a DIFFERENT-category preference the new one contradicts", async () => {
    const id = await findSupersededPreferenceId(
      "write in flowing prose, no lists",
      "pref-style",
      existing,
      opts((p) => (p.includes("bullet points") ? "CONTRADICT" : "UNRELATED"))
    );
    expect(id).toBe("pref-format");
  });

  it("returns undefined when nothing contradicts (prefs coexist)", async () => {
    const id = await findSupersededPreferenceId("use a friendly tone", "pref-style", existing, opts(() => "UNRELATED"));
    expect(id).toBeUndefined();
  });

  it("never supersedes the same-id (same-category) slot — that's handled by the upsert key", async () => {
    // Even if the model would say CONTRADICT, the same-id slot is skipped.
    const id = await findSupersededPreferenceId(
      "answer tersely",
      "pref-format",
      [{ id: "pref-format", value: "answer verbosely" }],
      opts(() => "CONTRADICT")
    );
    expect(id).toBeUndefined();
  });

  it("does NOT supersede on AGREE / UNRELATED / uncertain (fail-open)", async () => {
    expect(await findSupersededPreferenceId("x", "pref-style", existing, opts(() => "AGREE"))).toBeUndefined();
    expect(await findSupersededPreferenceId("x", "pref-style", existing, opts(() => "garbled non-verdict"))).toBeUndefined();
  });

  it("empty new value or empty existing list is undefined (no model call)", async () => {
    let called = 0;
    const counting = { model: "m", modelProvider: { generate: async (r: ModelRequest) => { called += 1; return { id: "r", model: r.model, output: "CONTRADICT" }; } } };
    expect(await findSupersededPreferenceId("   ", "pref-style", existing, counting)).toBeUndefined();
    expect(await findSupersededPreferenceId("x", "pref-style", [], counting)).toBeUndefined();
    expect(called).toBe(0);
  });

  it("caps the number of contradiction classifications (bounded model spend)", async () => {
    let called = 0;
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `pref-${i.toString()}`, value: `rule ${i.toString()}` }));
    const counting = { model: "m", modelProvider: { generate: async (r: ModelRequest) => { called += 1; return { id: "r", model: r.model, output: "UNRELATED" }; } }, maxClassifications: 3 };
    await findSupersededPreferenceId("new pref", "pref-style", many, counting);
    expect(called).toBe(3);
  });

  it("exports a sane default cap", () => {
    expect(DEFAULT_PREFERENCE_SUPERSEDE_MAX).toBeGreaterThan(0);
  });
});
