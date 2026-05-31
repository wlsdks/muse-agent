import { describe, expect, it } from "vitest";

import type { MuseEnvironment } from "../src/index.js";
import { createResponseFilters, responseLocales } from "../src/response-filters.js";

const env = (overrides: Record<string, string> = {}): MuseEnvironment => overrides as MuseEnvironment;
const ids = (filters: readonly { readonly id: string }[]) => filters.map((f) => f.id);
const localeSet = (overrides: Record<string, string> = {}) => [...responseLocales(env(overrides))].sort();

describe("responseLocales", () => {
  it("defaults to both ko and en when unset", () => {
    expect(localeSet()).toEqual(["en", "ko"]);
  });

  it("honours an explicit single locale and a both-locale list (case/whitespace-insensitive)", () => {
    expect(localeSet({ MUSE_RESPONSE_LOCALES: "ko" })).toEqual(["ko"]);
    expect(localeSet({ MUSE_RESPONSE_LOCALES: "en" })).toEqual(["en"]);
    expect(localeSet({ MUSE_RESPONSE_LOCALES: "  KO , En " })).toEqual(["en", "ko"]);
  });

  it("keeps the recognized locales from a mixed list and drops unknown entries", () => {
    expect(localeSet({ MUSE_RESPONSE_LOCALES: "ko,fr" })).toEqual(["ko"]);
  });

  it("falls back to both locales when no entry is recognized (config typo must not disable filters)", () => {
    expect(localeSet({ MUSE_RESPONSE_LOCALES: "fr,english" })).toEqual(["en", "ko"]);
  });
});

describe("createResponseFilters", () => {
  it("assembles the full default pipeline with both locale variants", () => {
    expect(ids(createResponseFilters(env()))).toEqual([
      "sanitized-text-response-filter",
      "markdown-strip-response-filter",
      "casual-lure-strip-response-filter",
      "english-casual-lure-strip-response-filter",
      "greeting-strip-response-filter",
      "english-greeting-strip-response-filter",
      "fabrication-request-refusal-filter",
      "source-block-response-filter",
      "verified-sources-response-filter",
      "tool-result-quality-audit-filter",
      "response-count-injection-filter",
      "response-count-consistency-filter",
      "zero-result-overclaim-response-filter",
      "structured-output-response-filter",
    ]);
  });

  it("prepends a max-length filter only when MUSE_RESPONSE_MAX_LENGTH is positive", () => {
    expect(ids(createResponseFilters(env({ MUSE_RESPONSE_MAX_LENGTH: "500" })))[0]).toBe("max-length-response-filter");
    expect(ids(createResponseFilters(env({ MUSE_RESPONSE_MAX_LENGTH: "0" })))).not.toContain("max-length-response-filter");
  });

  it("drops the english locale variants when only ko is enabled", () => {
    const koOnly = ids(createResponseFilters(env({ MUSE_RESPONSE_LOCALES: "ko" })));
    expect(koOnly).toContain("casual-lure-strip-response-filter");
    expect(koOnly).toContain("greeting-strip-response-filter");
    expect(koOnly).not.toContain("english-casual-lure-strip-response-filter");
    expect(koOnly).not.toContain("english-greeting-strip-response-filter");
  });

  it("removes individual filters when their flag is disabled", () => {
    expect(ids(createResponseFilters(env({ MUSE_RESPONSE_MARKDOWN_STRIP_FILTER_ENABLED: "false" })))).not.toContain(
      "markdown-strip-response-filter",
    );
    expect(ids(createResponseFilters(env({ MUSE_RESPONSE_GREETING_STRIP_ENABLED: "false" }))).filter((id) => id.includes("greeting"))).toEqual([]);
  });

  it("produces an empty pipeline when every filter flag is off", () => {
    const allOff: Record<string, string> = {};
    for (const key of [
      "SANITIZED_TEXT_FILTER",
      "MARKDOWN_STRIP_FILTER",
      "CASUAL_LURE_STRIP",
      "GREETING_STRIP",
      "FABRICATION_REFUSAL",
      "SOURCE_FILTER",
      "VERIFIED_SOURCES",
      "TOOL_RESULT_QUALITY_AUDIT",
      "COUNT_INJECTION",
      "COUNT_CONSISTENCY",
      "ZERO_RESULT_OVERCLAIM_FILTER",
      "STRUCTURED_OUTPUT_FILTER",
    ]) {
      allOff[`MUSE_RESPONSE_${key}_ENABLED`] = "false";
    }
    expect(createResponseFilters(env(allOff))).toEqual([]);
  });
});

describe("createResponseFilters — sanitized-text inlineReplacement locale default", () => {
  const sanitizeWith = (overrides: Record<string, string>): string | undefined => {
    const filter = createResponseFilters(env(overrides)).find((f) => f.id === "sanitized-text-response-filter") as
      | { apply: (r: { id: string; model: string; output: string }) => { output: string } }
      | undefined;
    return filter?.apply({ id: "r", model: "m", output: "before [SANITIZED] after" }).output;
  };

  it("uses the English '(redacted)' default ONLY for an en-only locale (en AND not ko)", () => {
    expect(sanitizeWith({ MUSE_RESPONSE_LOCALES: "en" })).toBe("before (redacted) after");
  });

  it("uses the Korean-first '(보안 처리됨)' default for ko-only OR both locales", () => {
    expect(sanitizeWith({ MUSE_RESPONSE_LOCALES: "ko" })).toBe("before (보안 처리됨) after");
    expect(sanitizeWith({})).toBe("before (보안 처리됨) after"); // both (default) → Korean-first
  });

  it("an explicit MUSE_RESPONSE_SANITIZED_TEXT_REPLACEMENT overrides the locale default (the ??)", () => {
    expect(sanitizeWith({ MUSE_RESPONSE_LOCALES: "en", MUSE_RESPONSE_SANITIZED_TEXT_REPLACEMENT: "[hidden]" }))
      .toBe("before [hidden] after");
  });
});
