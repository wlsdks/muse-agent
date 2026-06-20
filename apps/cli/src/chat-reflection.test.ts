import { describe, expect, it, vi } from "vitest";

import {
  REFLECTION_MIN_EPISODES,
  buildModelGroundingReverify,
  buildReflectionInput,
  formatReflection,
  synthesizeReflection,
  type ReflectionProvider
} from "./chat-reflection.js";

function fakeProvider(output: string | undefined): ReflectionProvider & { calls: number } {
  const p = {
    calls: 0,
    async generate() {
      p.calls += 1;
      return { ...(output !== undefined ? { output } : {}) };
    }
  };
  return p;
}

const eps = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ endedAt: `2026-05-0${i + 1}T10:00:00.000Z`, summary: `session ${i + 1}`, topics: ["budget"] }));

describe("synthesizeReflection — fence + grounding", () => {
  it(`short-circuits to "" below ${REFLECTION_MIN_EPISODES} episodes WITHOUT calling the model`, async () => {
    const provider = fakeProvider('{"insight":"should not be used"}');
    const out = await synthesizeReflection({ episodes: eps(1), model: "m", provider });
    expect(out).toBe("");
    expect(provider.calls).toBe(0);
  });

  it("returns the model's grounded insight when one is produced", async () => {
    const provider = fakeProvider('{"insight":"You keep returning to the budget."}');
    const out = await synthesizeReflection({ episodes: eps(3), model: "m", provider });
    expect(out).toBe("You keep returning to the budget.");
    expect(provider.calls).toBe(1);
  });

  it('treats {"insight":""} (no honest pattern) as "" — not a forced fabrication', async () => {
    const out = await synthesizeReflection({ episodes: eps(3), model: "m", provider: fakeProvider('{"insight":""}') });
    expect(out).toBe("");
  });

  it('returns "" on non-JSON / missing output / thrown provider (never a crash)', async () => {
    expect(await synthesizeReflection({ episodes: eps(3), model: "m", provider: fakeProvider("sorry, I cannot") })).toBe("");
    expect(await synthesizeReflection({ episodes: eps(3), model: "m", provider: fakeProvider(undefined) })).toBe("");
    const thrower: ReflectionProvider = { generate: vi.fn().mockRejectedValue(new Error("boom")) };
    expect(await synthesizeReflection({ episodes: eps(3), model: "m", provider: thrower })).toBe("");
  });

  it("strips terminal-control bytes from the model's insight (JSON-escaped ESC)", async () => {
    // The model emits a JSON-valid  escape; once parsed it's a real ESC
    // byte the sanitiser must drop before it reaches the terminal.
    const out = await synthesizeReflection({
      episodes: eps(3),
      model: "m",
      provider: fakeProvider('{"insight":"You \\u001b[31mkeep returning\\u001b[0m to it."}')
    });
    expect(out).not.toContain(String.fromCharCode(27));
    expect(out).toContain("keep returning");
  });

  it("ignores empty-summary episodes when counting material", async () => {
    const provider = fakeProvider('{"insight":"x"}');
    const blanks = [{ endedAt: "2026-05-01", summary: "  " }, { endedAt: "2026-05-02", summary: "" }];
    expect(await synthesizeReflection({ episodes: blanks, model: "m", provider })).toBe("");
    expect(provider.calls).toBe(0);
  });
});

describe("synthesizeReflection — faithfulness reverify (in-chat parity with the offline dreaming gate; GROUNDED≠TRUE)", () => {
  const reflected = (insight: string): ReflectionProvider => fakeProvider(`{"insight":"${insight}"}`);
  it("DROPS an insight the reverify judge does NOT support — a confabulated observation never reaches the live chat", async () => {
    const reverify = vi.fn().mockResolvedValue(false);
    const out = await synthesizeReflection({ episodes: eps(3), model: "m", provider: reflected("You never finished the Q3 report."), reverify });
    expect(out).toBe("");
    expect(reverify).toHaveBeenCalledTimes(1);
  });
  it("KEEPS an insight the reverify judge supports", async () => {
    const reverify = vi.fn().mockResolvedValue(true);
    expect(await synthesizeReflection({ episodes: eps(3), model: "m", provider: reflected("You keep returning to the budget."), reverify })).toBe("You keep returning to the budget.");
  });
  it("fail-closes: a reverify that THROWS drops the insight (a dream never survives an unverifiable check)", async () => {
    const reverify = vi.fn().mockRejectedValue(new Error("judge down"));
    expect(await synthesizeReflection({ episodes: eps(3), model: "m", provider: reflected("x"), reverify })).toBe("");
  });
  it("checks the insight against the cited episodes' TEXT (passes their summaries as evidence)", async () => {
    let seenEvidence = "";
    const reverify = vi.fn(async ({ evidence }: { readonly evidence: string }) => { seenEvidence = evidence; return true; });
    await synthesizeReflection({ episodes: eps(3), model: "m", provider: reflected("budget recurs"), reverify });
    expect(seenEvidence).toContain("session 1");
    expect(seenEvidence).toContain("session 3");
  });
  it("does NOT call the judge for an empty insight (nothing to verify)", async () => {
    const reverify = vi.fn().mockResolvedValue(true);
    expect(await synthesizeReflection({ episodes: eps(3), model: "m", provider: reflected(""), reverify })).toBe("");
    expect(reverify).not.toHaveBeenCalled();
  });
  it("back-compat: no reverify supplied → returns the insight unverified (mirrors the offline path's optional gate)", async () => {
    expect(await synthesizeReflection({ episodes: eps(3), model: "m", provider: reflected("y") })).toBe("y");
  });
});

describe("buildModelGroundingReverify — the in-chat judge mirrors the offline RGV reverify", () => {
  it("returns true when the judge says the insight is supported, false when not", async () => {
    const yes = buildModelGroundingReverify(fakeProvider('{"supported":true}'), "m");
    const no = buildModelGroundingReverify(fakeProvider('{"supported":false}'), "m");
    expect(await yes({ answer: "a", evidence: "e", query: "q" })).toBe(true);
    expect(await no({ answer: "a", evidence: "e", query: "q" })).toBe(false);
  });
  it("end-to-end: synthesizeReflection + a model-built judge that rejects DROPS the dream", async () => {
    const insightProvider = fakeProvider('{"insight":"You abandoned the launch plan."}');
    const rejectingJudge = buildModelGroundingReverify(fakeProvider('{"supported":false}'), "m");
    expect(await synthesizeReflection({ episodes: eps(3), model: "m", provider: insightProvider, reverify: rejectingJudge })).toBe("");
  });
});

describe("buildReflectionInput", () => {
  it("lists dated summaries with topics and a recurring-threads line", () => {
    const input = buildReflectionInput(
      [{ endedAt: "2026-05-12T10:00:00.000Z", summary: "talked Q3 budget", topics: ["Q3 budget"] }],
      [{ topic: "Q3 budget", sessions: 3 }]
    );
    expect(input).toContain("2026-05-12: talked Q3 budget [Q3 budget]");
    expect(input).toContain("Recurring topics (sessions): Q3 budget (3)");
  });
  it("says none when no recurring threads", () => {
    expect(buildReflectionInput([{ endedAt: "2026-05-12", summary: "one-off" }], [])).toContain("none detected");
  });
});

describe("formatReflection", () => {
  it("prefixes a real insight and gives a friendly empty-state otherwise", () => {
    expect(formatReflection("You keep returning to X.")).toBe("🪞 You keep returning to X.");
    expect(formatReflection("")).toMatch(/Nothing stands out/);
  });
});
