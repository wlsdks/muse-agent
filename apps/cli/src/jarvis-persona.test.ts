import { describe, expect, it } from "vitest";

import { buildJarvisPersona } from "./program.js";

describe("buildJarvisPersona", () => {
  it("returns undefined when memory is empty (no system-prompt bloat for first-time users)", () => {
    expect(
      buildJarvisPersona({ facts: {}, preferences: {} }, "stark")
    ).toBeUndefined();
  });

  it("renders a JARVIS-style system prompt with facts + preferences", () => {
    const prompt = buildJarvisPersona(
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
    const prompt = buildJarvisPersona({ facts: { name: "Stark" }, preferences: {} }, "stark");
    expect(prompt).toMatch(/Do NOT volunteer/i);
  });

  it("handles facts-only or preferences-only inputs", () => {
    expect(
      buildJarvisPersona({ facts: { name: "Stark" }, preferences: {} }, "stark")
    ).toContain("name: Stark");
    expect(
      buildJarvisPersona({ facts: {}, preferences: { language: "Korean" } }, "stark")
    ).toContain("language: Korean");
  });

  it("embeds the userId so a shared-machine setup can address each user correctly", () => {
    const a = buildJarvisPersona({ facts: { name: "Stark" }, preferences: {} }, "tony");
    const b = buildJarvisPersona({ facts: { name: "Rhodey" }, preferences: {} }, "james");
    expect(a).toContain('"tony"');
    expect(b).toContain('"james"');
  });

  it("renders veto: prefixed preferences under their own header with refusal directive", () => {
    const prompt = buildJarvisPersona(
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
    const prompt = buildJarvisPersona(
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
      buildJarvisPersona({ facts: {}, preferences: {} }, "stark")
    ).toBeUndefined();
  });
});
