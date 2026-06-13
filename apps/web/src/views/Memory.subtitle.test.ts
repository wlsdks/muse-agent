import { describe, expect, it } from "vitest";

import { DICTIONARIES } from "../i18n/strings.js";
import { memorySubtitle } from "./Memory.js";

import type { StringKey } from "../i18n/strings.js";

// Mirror i18n fill() so the test exercises the real shipped dictionary strings.
const makeT =
  (lang: "en" | "ko") =>
  (key: StringKey, vars?: Record<string, string | number>): string => {
    const tmpl = DICTIONARIES[lang][key];
    return vars
      ? tmpl.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
      : tmpl;
  };

describe("memorySubtitle — no dangling label when the memory has no timestamp", () => {
  it("renders a clean self-contained sentence when updatedAt is absent (en + ko)", () => {
    expect(memorySubtitle(makeT("en"), "en-US", undefined)).toBe("What Muse has learned about you.");
    expect(memorySubtitle(makeT("ko"), "ko-KR", undefined)).toBe("Muse가 당신에 대해 학습한 것.");
    // The old bug: subtitle ended with a dangling label word.
    expect(memorySubtitle(makeT("en"), "en-US", undefined)).not.toMatch(/Updated\s*$/);
    expect(memorySubtitle(makeT("ko"), "ko-KR", undefined)).not.toMatch(/업데이트\s*$/);
  });

  it("binds the Updated label to its timestamp when present", () => {
    const iso = "2026-06-13T10:00:00Z";
    const out = memorySubtitle(makeT("en"), "en-US", iso);
    expect(out).toContain("What Muse has learned about you.");
    expect(out).toContain("Updated");
    expect(out).toContain(new Date(iso).toLocaleString("en-US"));
  });
});
