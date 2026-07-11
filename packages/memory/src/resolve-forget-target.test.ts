import { describe, expect, it } from "vitest";

import { resolveForgetTarget } from "./memory-user-store.js";

describe("resolveForgetTarget", () => {
  it("resolves an exact stored key", () => {
    const target = resolveForgetTarget({ facts: { home_city: "Seoul" }, preferences: {} }, "home_city");
    expect(target).toEqual({ dropFact: true, dropPref: true, key: "home_city" });
  });

  it("normalizes a raw key not stored verbatim (\"Home City\" -> \"home_city\")", () => {
    const target = resolveForgetTarget({ facts: { home_city: "Seoul" }, preferences: {} }, "Home City");
    expect(target).toEqual({ dropFact: true, dropPref: true, key: "home_city" });
  });

  it("kind=\"fact\" preserves a same-key preference (only drops the fact)", () => {
    const target = resolveForgetTarget(
      { facts: { favorite_color: "blue" }, preferences: { favorite_color: "green" } },
      "favorite_color",
      "fact"
    );
    expect(target).toEqual({ dropFact: true, dropPref: false, key: "favorite_color" });
  });

  it("kind=\"preference\" preserves a same-key fact (only drops the preference)", () => {
    const target = resolveForgetTarget(
      { facts: { favorite_color: "blue" }, preferences: { favorite_color: "green" } },
      "favorite_color",
      "preference"
    );
    expect(target).toEqual({ dropFact: false, dropPref: true, key: "favorite_color" });
  });

  it("omitting kind flags a dual-delete when both namespaces hold the key", () => {
    const target = resolveForgetTarget(
      { facts: { favorite_color: "blue" }, preferences: { favorite_color: "green" } },
      "favorite_color"
    );
    expect(target).toEqual({ dropFact: true, dropPref: true, key: "favorite_color" });
  });

  it("returns null when the key exists in neither namespace", () => {
    const target = resolveForgetTarget({ facts: { home_city: "Seoul" }, preferences: {} }, "unknown_key");
    expect(target).toBeNull();
  });

  it("returns null when kind scopes away the only namespace holding the key", () => {
    const target = resolveForgetTarget(
      { facts: { home_city: "Seoul" }, preferences: {} },
      "home_city",
      "preference"
    );
    expect(target).toBeNull();
  });

  it("resolves a key present only in facts", () => {
    const target = resolveForgetTarget({ facts: { home_city: "Seoul" }, preferences: {} }, "home_city");
    expect(target).toEqual({ dropFact: true, dropPref: true, key: "home_city" });
  });

  it("resolves a key present only in preferences", () => {
    const target = resolveForgetTarget({ facts: {}, preferences: { theme: "dark" } }, "theme");
    expect(target).toEqual({ dropFact: true, dropPref: true, key: "theme" });
  });
});
