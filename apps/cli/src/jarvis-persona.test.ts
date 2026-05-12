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
});
