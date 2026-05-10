/**
 * Response-filter assembly for the runtime: turns env flags into a
 * concrete pipeline of `ResponseFilter`s consumed by
 * `createAgentRuntime`. Extracted from `index.ts` to keep the big
 * runtime-assembly factory focused on wiring, not on filter policy.
 *
 * The env parsers live in `./env-parsers.js` so this module doesn't
 * have to import from `index.js` (the prior arrangement worked via
 * hoisted-function circular import; the dedicated module is cleaner).
 */

import {
  createCasualLureStripResponseFilter,
  createEnglishCasualLureStripResponseFilter,
  createEnglishGreetingStripResponseFilter,
  createFabricationRequestRefusalFilter,
  createGreetingStripResponseFilter,
  createMarkdownStripResponseFilter,
  createMaxLengthResponseFilter,
  createResponseCountConsistencyFilter,
  createResponseCountInjectionFilter,
  createSanitizedTextResponseFilter,
  createSourceBlockResponseFilter,
  createStructuredOutputResponseFilter,
  createToolResultQualityAuditFilter,
  createVerifiedSourcesResponseFilter,
  createZeroResultOverclaimResponseFilter
} from "@muse/agent-core";

import { parseBoolean, parseCsv, parseInteger, parseOptionalString } from "./env-parsers.js";
import type { MuseEnvironment } from "./index.js";

function responseLocales(env: MuseEnvironment): ReadonlySet<"ko" | "en"> {
  const raw = parseCsv(env.MUSE_RESPONSE_LOCALES) ?? ["ko", "en"];
  const result = new Set<"ko" | "en">();
  for (const entry of raw) {
    const lower = entry.trim().toLowerCase();
    if (lower === "ko" || lower === "en") {
      result.add(lower);
    }
  }
  return result;
}

function buildCasualLureFilters(env: MuseEnvironment) {
  if (!parseBoolean(env.MUSE_RESPONSE_CASUAL_LURE_STRIP_ENABLED, true)) {
    return [];
  }
  const locales = responseLocales(env);
  return [
    ...(locales.has("ko") ? [createCasualLureStripResponseFilter()] : []),
    ...(locales.has("en") ? [createEnglishCasualLureStripResponseFilter()] : [])
  ];
}

function buildGreetingStripFilters(env: MuseEnvironment) {
  if (!parseBoolean(env.MUSE_RESPONSE_GREETING_STRIP_ENABLED, true)) {
    return [];
  }
  const locales = responseLocales(env);
  return [
    ...(locales.has("ko") ? [createGreetingStripResponseFilter()] : []),
    ...(locales.has("en") ? [createEnglishGreetingStripResponseFilter()] : [])
  ];
}

export function createResponseFilters(env: MuseEnvironment) {
  const maxLength = parseInteger(env.MUSE_RESPONSE_MAX_LENGTH, 0);

  return [
    ...(maxLength > 0 ? [createMaxLengthResponseFilter({ maxLength })] : []),
    ...(parseBoolean(env.MUSE_RESPONSE_SANITIZED_TEXT_FILTER_ENABLED, true)
      ? [createSanitizedTextResponseFilter({
          inlineReplacement: parseOptionalString(env.MUSE_RESPONSE_SANITIZED_TEXT_REPLACEMENT)
            ?? (responseLocales(env).has("en") && !responseLocales(env).has("ko")
              ? "(redacted)"
              : "(보안 처리됨)")
        })]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_MARKDOWN_STRIP_FILTER_ENABLED, true)
      ? [createMarkdownStripResponseFilter()]
      : []),
    ...buildCasualLureFilters(env),
    ...buildGreetingStripFilters(env),
    ...(parseBoolean(env.MUSE_RESPONSE_FABRICATION_REFUSAL_ENABLED, true)
      ? [createFabricationRequestRefusalFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_SOURCE_FILTER_ENABLED, true)
      ? [createSourceBlockResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_VERIFIED_SOURCES_ENABLED, true)
      ? [createVerifiedSourcesResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_TOOL_RESULT_QUALITY_AUDIT_ENABLED, true)
      ? [createToolResultQualityAuditFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_COUNT_INJECTION_ENABLED, true)
      ? [createResponseCountInjectionFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_COUNT_CONSISTENCY_ENABLED, true)
      ? [createResponseCountConsistencyFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_ZERO_RESULT_OVERCLAIM_FILTER_ENABLED, true)
      ? [createZeroResultOverclaimResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_STRUCTURED_OUTPUT_FILTER_ENABLED, true)
      ? [createStructuredOutputResponseFilter()]
      : [])
  ];
}
