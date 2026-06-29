import { describe, expect, it } from "vitest";

import { normalizeMemoryKey } from "../src/index.js";

describe("normalizeMemoryKey NFC (KO fact keys match regardless of NFD/NFC origin)", () => {
  it("an NFD Korean key and its NFC form normalize to the SAME key (lookup no longer misses)", () => {
    const nfd = "와이파이 비밀번호".normalize("NFD");
    const nfc = "와이파이 비밀번호".normalize("NFC");
    expect([...nfd].length).toBeGreaterThan([...nfc].length); // genuinely decomposed
    expect(normalizeMemoryKey(nfd)).toBe(normalizeMemoryKey(nfc));
  });
  it("the existing slug behavior is unchanged for ASCII (camelCase split, lowercase, underscore)", () => {
    expect(normalizeMemoryKey("WiFi Password")).toBe("wi_fi_password");
    expect(normalizeMemoryKey("home-address")).toBe("home_address");
  });
});

describe("normalizeMemoryKey full-width fold", () => {
  it("a full-width-digit KO key matches its ASCII form", () => {
    expect(normalizeMemoryKey("와이파이 １２３".normalize("NFC"))).toBe(normalizeMemoryKey("와이파이 123"));
  });
});
