import { describe, expect, it } from "vitest";

import { BUILTIN_PERSONAS, isBuiltinPersonaId, personaIdIsKnown, resolveActivePersonaPreamble } from "./persona-store.js";

const store = (activeId: string, custom: Record<string, { preamble: string }> = {}) => ({ activeId, custom });

describe("isBuiltinPersonaId", () => {
  it("recognises shipped builtin ids and rejects unknown ones", () => {
    expect(isBuiltinPersonaId("jarvis")).toBe(true);
    expect(isBuiltinPersonaId("definitely-not-a-persona")).toBe(false);
  });
});

describe("personaIdIsKnown", () => {
  it("is true for a builtin or a stored custom id, false otherwise", () => {
    const s = store("jarvis", { mine: { preamble: "p" } });
    expect(personaIdIsKnown(s, "jarvis")).toBe(true);
    expect(personaIdIsKnown(s, "mine")).toBe(true);
    expect(personaIdIsKnown(s, "ghost")).toBe(false);
  });
});

describe("resolveActivePersonaPreamble", () => {
  it("returns the active builtin's preamble", () => {
    const jarvis = BUILTIN_PERSONAS.find((p) => p.id === "jarvis")!;
    expect(resolveActivePersonaPreamble(store("jarvis"))).toBe(jarvis.preamble);
  });

  it("prefers a non-empty custom preamble over a builtin of the same id", () => {
    expect(resolveActivePersonaPreamble(store("jarvis", { jarvis: { preamble: "my override" } }))).toBe("my override");
  });

  it("falls back to the builtin when the custom preamble is empty", () => {
    const jarvis = BUILTIN_PERSONAS.find((p) => p.id === "jarvis")!;
    expect(resolveActivePersonaPreamble(store("jarvis", { jarvis: { preamble: "" } }))).toBe(jarvis.preamble);
  });

  it("returns empty string for an unknown active id with no custom entry", () => {
    expect(resolveActivePersonaPreamble(store("nope"))).toBe("");
  });
});
