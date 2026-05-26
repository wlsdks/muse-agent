import { describe, expect, it } from "vitest";

import { DICTIONARIES, LOCALES } from "./strings.js";

describe("i18n dictionaries", () => {
  it("ships en and ko with identical key sets", () => {
    const enKeys = Object.keys(DICTIONARIES.en).sort();
    const koKeys = Object.keys(DICTIONARIES.ko).sort();
    expect(koKeys).toEqual(enKeys);
  });

  it("leaves no key with an empty translation", () => {
    for (const lang of ["en", "ko"] as const) {
      for (const [key, value] of Object.entries(DICTIONARIES[lang])) {
        expect(value.trim(), `${lang}:${key}`).not.toBe("");
      }
    }
  });

  it("keeps placeholder tokens consistent across languages", () => {
    const tokens = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of Object.keys(DICTIONARIES.en) as (keyof typeof DICTIONARIES.en)[]) {
      expect(tokens(DICTIONARIES.ko[key]), key).toEqual(tokens(DICTIONARIES.en[key]));
    }
  });

  it("maps each language to a BCP-47 locale", () => {
    expect(LOCALES.en).toBe("en-US");
    expect(LOCALES.ko).toBe("ko-KR");
  });
});
