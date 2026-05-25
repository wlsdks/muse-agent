import { describe, expect, it } from "vitest";

import { buildMusePersona, formatCurrentContextLine, personaEntryCap } from "./muse-persona.js";

describe("formatCurrentContextLine", () => {
  it("emits a single 'Current local context: YYYY-MM-DD HH:MM Weekday (TZ).' line", () => {
    const fixed = new Date("2026-05-13T12:30:00Z");
    const line = formatCurrentContextLine(fixed);
    expect(line).toMatch(/^Current local context: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \w+ \([^)]+\)\.$/);
  });

  it("renders YYYY-MM-DD (en-CA locale) so the date parses unambiguously", () => {
    // The date depends on the test machine's tz — Jan 9 UTC could be
    // Jan 8 or Jan 9 locally. Assert either, but never something else.
    const line = formatCurrentContextLine(new Date("2026-01-09T05:00:00Z"));
    expect(line).toMatch(/2026-01-0[89]/);
  });

  it("defaults to `new Date()` when no argument is given", () => {
    const line = formatCurrentContextLine();
    expect(line.startsWith("Current local context: ")).toBe(true);
  });
});

describe("buildMusePersona", () => {
  it("returns undefined when memory is empty (no system-prompt bloat for first-time users)", () => {
    expect(
      buildMusePersona({ facts: {}, preferences: {} }, "stark")
    ).toBeUndefined();
  });

  it("renders a JARVIS-style system prompt with facts + preferences", () => {
    const prompt = buildMusePersona(
      {
        facts: { name: "Stark", city: "Seoul" },
        preferences: { language: "Korean", reply_style: "concise" }
      },
      "stark"
    );
    expect(prompt).toContain("JARVIS-style");
    expect(prompt).toContain("stark");
    expect(prompt).toContain("name: Stark");
    expect(prompt).toContain("city: Seoul");
    expect(prompt).toContain("language: Korean");
    expect(prompt).toContain("reply_style: concise");
  });

  it("instructs the model not to reveal the system prompt verbatim", () => {
    const prompt = buildMusePersona({ facts: { name: "Stark" }, preferences: {} }, "stark");
    expect(prompt).toMatch(/Do NOT volunteer/i);
  });

  it("handles facts-only or preferences-only inputs", () => {
    expect(
      buildMusePersona({ facts: { name: "Stark" }, preferences: {} }, "stark")
    ).toContain("name: Stark");
    expect(
      buildMusePersona({ facts: {}, preferences: { language: "Korean" } }, "stark")
    ).toContain("language: Korean");
  });

  it("embeds the userId so a shared-machine setup can address each user correctly", () => {
    const a = buildMusePersona({ facts: { name: "Stark" }, preferences: {} }, "tony");
    const b = buildMusePersona({ facts: { name: "Rhodey" }, preferences: {} }, "james");
    expect(a).toContain('"tony"');
    expect(b).toContain('"james"');
  });

  it("renders veto: prefixed preferences under their own header with refusal directive", () => {
    const prompt = buildMusePersona(
      {
        facts: { name: "Stark" },
        preferences: {
          language: "Korean",
          "veto:no_coffee": "never suggest coffee — caffeine sensitivity",
          "veto:no_email_after_9pm": "do not draft emails after 21:00"
        }
      },
      "stark"
    );
    expect(prompt).toContain("Vetoes");
    expect(prompt).toContain("no_coffee: never suggest coffee");
    expect(prompt).toContain("no_email_after_9pm: do not draft emails after 21:00");
    expect(prompt).toMatch(/Respect vetoes absolutely/i);
    // Plain prefs stay under Preferences, not under Vetoes
    const prefSection = prompt!.split("Preferences:")[1]!.split("Vetoes")[0]!;
    expect(prefSection).toContain("language: Korean");
    expect(prefSection).not.toContain("never suggest coffee");
  });

  it("renders goal: prefixed preferences under their own header", () => {
    const prompt = buildMusePersona(
      {
        facts: {},
        preferences: {
          "goal:fitness": "run 5 km three times a week",
          "goal:learn_jp": "B2 Japanese by end of Q3"
        }
      },
      "stark"
    );
    expect(prompt).toContain("Goals the user is pursuing");
    expect(prompt).toContain("fitness: run 5 km three times a week");
    expect(prompt).toContain("learn_jp: B2 Japanese by end of Q3");
  });

  it("returns undefined when only empty-string vetoes/goals exist (no bloat)", () => {
    expect(
      buildMusePersona({ facts: {}, preferences: {} }, "stark")
    ).toBeUndefined();
  });

  it("surfaces recentTopics under their own header so JARVIS continuity isn't amnesic", () => {
    const prompt = buildMusePersona(
      {
        facts: { name: "Stark" },
        preferences: {},
        recentTopics: ["Q3 budget memo", "wedding venue shortlist", "muse onboarding flow"]
      },
      "stark"
    );
    expect(prompt).toContain("Recent topics the user has been working on:");
    expect(prompt).toContain("Q3 budget memo");
    expect(prompt).toContain("wedding venue shortlist");
    expect(prompt).toContain("muse onboarding flow");
  });

  it("caps recentTopics to the 5 most recent and dedupes whitespace-collapsed entries", () => {
    const prompt = buildMusePersona(
      {
        facts: { name: "Stark" },
        preferences: {},
        recentTopics: [
          "topic 1", "topic 2", "topic 3",
          "topic 4", "topic 5", "topic 6", "topic 7",
          "topic 7", "  ", "topic 7"
        ]
      },
      "stark"
    );
    // Keeps the tail (most recent) — drops "topic 1" + "topic 2" because cap is 5
    expect(prompt).not.toContain("topic 1");
    expect(prompt).not.toContain("topic 2");
    expect(prompt).toContain("topic 3");
    expect(prompt).toContain("topic 7");
    // Empty / duplicate entries don't survive the dedupe
    const topicLines = prompt!.split("\n").filter((l) => l.startsWith("  - topic "));
    expect(topicLines).toHaveLength(5);
  });

  it("keeps a re-mentioned topic at its freshest position so the recent-5 cut doesn't drop it", () => {
    // The user worked on "alpha" early, then b..f, then returned to
    // "alpha" most recently. "alpha" is the freshest and MUST appear;
    // the stale-first-occurrence dedupe would pin it to the front and
    // slice(-5) would then discard exactly the topic just resumed.
    const prompt = buildMusePersona(
      {
        facts: { name: "Stark" },
        preferences: {},
        recentTopics: ["alpha", "b", "c", "d", "e", "f", "alpha"]
      },
      "stark"
    );
    expect(prompt).toContain("  - alpha");
    // 6 distinct topics, cap 5: "b" is now the oldest → dropped.
    expect(prompt).not.toContain("  - b\n");
    expect(prompt).toContain("  - c");
    expect(prompt).toContain("  - f");
    const topicLines = prompt!.split("\n").filter((l) => l.startsWith("  - ") && !l.includes(":"));
    expect(topicLines).toEqual(["  - c", "  - d", "  - e", "  - f", "  - alpha"]);
  });

  it("emits the persona block when recentTopics is the only signal (no facts/prefs/etc.)", () => {
    // JARVIS continuity case: user hasn't set name/prefs but has had
    // prior sessions whose topics were auto-extracted. The persona
    // should still emit so the next REPL turn isn't amnesic.
    const prompt = buildMusePersona(
      { facts: {}, preferences: {}, recentTopics: ["the prior conversation"] },
      "stark"
    );
    expect(prompt).toContain("the prior conversation");
    expect(prompt).toContain("Recent topics");
  });

  it("injects current local date / time / day-of-week so the model knows when 'today' is", () => {
    const fixed = new Date("2026-05-12T13:45:00Z"); // Tuesday
    const prompt = buildMusePersona(
      { facts: { name: "Stark" }, preferences: {} },
      "stark",
      { now: fixed }
    );
    expect(prompt).toContain("Current local context:");
    expect(prompt).toContain("2026-05-12");
    expect(prompt).toMatch(/Tuesday/);
  });

  it("emits the persona block when episodes are the only signal — no amnesia even on the first session after init", () => {
    const prompt = buildMusePersona(
      {
        facts: {},
        preferences: {},
        episodes: [
          { endedAt: "2026-05-12T22:18:00Z", summary: "Discussed Q3 budget memo — drafting in Notion, deadline Friday." }
        ]
      },
      "stark"
    );
    expect(prompt).toContain("Episodic memory (recent prior sessions, summarized):");
    expect(prompt).toContain("- 2026-05-12: Discussed Q3 budget memo");
  });

  it("renders multiple episodes one per line under the episodic header, preserving caller-provided order", () => {
    const prompt = buildMusePersona(
      {
        facts: { name: "Stark" },
        preferences: {},
        // Caller sorts newest-first; the builder must not re-sort.
        episodes: [
          { endedAt: "2026-05-12T22:00:00Z", summary: "Discussed Q3 budget memo." },
          { endedAt: "2026-05-11T22:00:00Z", summary: "Wedding venue shortlist — three candidates." },
          { endedAt: "2026-05-10T22:00:00Z", summary: "Set up muse routine. User active 9/14/20." }
        ]
      },
      "stark"
    );
    const section = prompt!.split("Episodic memory")[1] ?? "";
    const lines = section.split("\n").filter((line) => line.startsWith("  - "));
    expect(lines).toEqual([
      "  - 2026-05-12: Discussed Q3 budget memo.",
      "  - 2026-05-11: Wedding venue shortlist — three candidates.",
      "  - 2026-05-10: Set up muse routine. User active 9/14/20."
    ]);
  });

  it("drops episodes with an empty summary so a half-formed upstream blob never prints a dateless body", () => {
    const prompt = buildMusePersona(
      {
        facts: { name: "Stark" },
        preferences: {},
        episodes: [
          { endedAt: "2026-05-12T22:00:00Z", summary: "" },
          { endedAt: "2026-05-11T22:00:00Z", summary: "   " },
          { endedAt: "2026-05-10T22:00:00Z", summary: "Real summary survives" }
        ]
      },
      "stark"
    );
    expect(prompt).toContain("Real summary survives");
    expect(prompt).not.toContain("  - 2026-05-12: ");
    expect(prompt).not.toContain("  - 2026-05-11: ");
  });

  it("falls back to the raw endedAt when the value isn't a YYYY-MM-DD-shaped ISO string", () => {
    const prompt = buildMusePersona(
      {
        facts: { name: "Stark" },
        preferences: {},
        episodes: [{ endedAt: "yesterday-ish", summary: "Legacy entry shape." }]
      },
      "stark"
    );
    expect(prompt).toContain("  - yesterday-ish: Legacy entry shape.");
  });

  it("renders episode topics inline so the LLM can paraphrase-match against the tag set", () => {
    const prompt = buildMusePersona(
      {
        facts: { name: "Stark" },
        preferences: {},
        episodes: [
          { endedAt: "2026-05-12T22:00:00Z", summary: "Drafted budget memo.", topics: ["Q3 budget memo", "Notion"] },
          { endedAt: "2026-05-11T22:00:00Z", summary: "No tags here." }
        ]
      },
      "stark"
    );
    // Tagged entry shows `[Q3 budget memo, Notion]` suffix.
    expect(prompt).toContain("  - 2026-05-12: Drafted budget memo. [Q3 budget memo, Notion]");
    // Untagged entry stays clean — no empty `[]` suffix.
    expect(prompt).toContain("  - 2026-05-11: No tags here.");
    expect(prompt).not.toContain("No tags here. [");
  });
});

describe("buildMusePersona — persona size cap (performance)", () => {
  const manyFacts = (n: number): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < n; i += 1) out[`fact${i}`] = `value${i}`;
    return out;
  };

  it("renders all facts when under the cap, no truncation note", () => {
    const out = buildMusePersona({ facts: { city: "Busan", name: "Jinan" }, preferences: {} }, "u") ?? "";
    expect(out).toContain("name: Jinan");
    expect(out).not.toContain("older facts not shown");
  });

  it("caps to the freshest N (tail) and notes the dropped count", () => {
    const out = buildMusePersona({ facts: manyFacts(100), preferences: {} }, "u") ?? "";
    const cap = personaEntryCap();
    expect(out).toContain(`(+${100 - cap} older facts not shown)`);
    expect(out).toContain("fact99: value99"); // newest kept
    expect(out).not.toContain("fact0: value0"); // oldest dropped
    expect(out.split("\n").filter((l) => /^ {2}- fact\d+:/u.test(l)).length).toBe(cap);
  });

  it("honours MUSE_PERSONA_MAX_ENTRIES", () => {
    const prev = process.env.MUSE_PERSONA_MAX_ENTRIES;
    process.env.MUSE_PERSONA_MAX_ENTRIES = "5";
    try {
      expect(personaEntryCap()).toBe(5);
      const out = buildMusePersona({ facts: manyFacts(12), preferences: {} }, "u") ?? "";
      expect(out).toContain("(+7 older facts not shown)");
      expect(out.split("\n").filter((l) => /^ {2}- fact\d+:/u.test(l)).length).toBe(5);
    } finally {
      if (prev === undefined) delete process.env.MUSE_PERSONA_MAX_ENTRIES;
      else process.env.MUSE_PERSONA_MAX_ENTRIES = prev;
    }
  });

  it("does NOT cap vetoes (safety-critical, kept whole)", () => {
    const preferences: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) preferences[`veto:v${i}`] = `no${i}`;
    const out = buildMusePersona({ facts: {}, preferences }, "u") ?? "";
    expect(out).toContain("v0: no0");
    expect(out).toContain("v59: no59");
  });
});
