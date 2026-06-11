import type { ModelResponse } from "@muse/model";
import { sanitizeSourceBlocks } from "@muse/policy";

import {
  isRecord,
  joinUserMessages,
  normalizeSourceUrl,
  withResponseFilterRaw
} from "./internals.js";
import type { ResponseFilterContext, ResponseFilterStage, VerifiedSource } from "./types.js";

/**
 * Verified-sources response filters.
 *
 * Two factories live here together because they share the entire
 * `uniqueVerifiedSources` / `buildFallbackVerifiedResponse` /
 * `maybeAppendToolInsights` helper cluster. Splitting them would
 * duplicate ~150 LOC of helpers; keeping them together preserves
 * cohesion. Extracted from `response-filters.ts` to keep that file
 * readable.
 */

export function createVerifiedSourcesResponseFilter(): ResponseFilterStage {
  return {
    apply: (response, context) => {
      const cleaned = sanitizeSourceBlocks(response.output).content.trim();
      const sources = uniqueVerifiedSources(context.verifiedSources ?? []).slice(0, 5);

      if (isCasualPromptText(joinUserMessages(context.input.messages))) {
        return cleaned === response.output ? response : {
          ...response,
          output: cleaned,
          raw: withResponseFilterRaw(response, "verified-sources-response-filter")
        };
      }

      let output = cleaned;

      if (output.length === 0 && (sources.length > 0 || (context.toolInsights ?? []).length > 0)) {
        output = buildFallbackVerifiedResponse(joinUserMessages(context.input.messages), sources, context.toolInsights ?? []);
      }

      output = maybeAppendToolInsights(output, context);

      if (sources.length > 0 && !hasEquivalentSourceBlock(output, sources)) {
        output = `${output.trimEnd()}\n\n${buildVerifiedSourcesBlock(joinUserMessages(context.input.messages), sources)}`;
      }

      if (output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "verified-sources-response-filter")
      };
    },
    id: "verified-sources-response-filter"
  };
}

export function createSourceBlockResponseFilter(): ResponseFilterStage {
  return {
    apply: (response: ModelResponse) => {
      const result = sanitizeSourceBlocks(response.output);

      if (!result.removed) {
        return response;
      }

      return {
        ...response,
        output: result.content,
        raw: {
          ...(isRecord(response.raw) ? response.raw : {}),
          museResponseFilter: {
            id: "source-block-response-filter",
            reason: result.reason
          }
        }
      };
    },
    id: "source-block-response-filter"
  };
}

function uniqueVerifiedSources(sources: readonly VerifiedSource[]): readonly VerifiedSource[] {
  const byUrl = new Map<string, VerifiedSource>();

  for (const source of sources) {
    const key = normalizeSourceUrl(source.url);

    if (!byUrl.has(key)) {
      byUrl.set(key, source);
    }
  }

  return [...byUrl.values()];
}

export function isCasualPromptText(prompt: string): boolean {
  const cleaned = prompt
    .replace(/^\s*\[[^\]]+\]\s*/u, "")
    .replace(/^\s*\[SYSTEM_META\][^\n]*\n?/gmu, "")
    .trim();

  if (cleaned.length === 0) {
    return true;
  }

  // `\b` is an ASCII word boundary — it never matches after a Korean
  // (non-`\w`) character, so the Hangul greetings here all failed to
  // match. A Unicode-aware negative lookahead (no letter/number
  // follows) is the real "whole-token" boundary: matches "안녕" / "네"
  // / "thanks" but not "네이버" / "thanksgiving".
  return /^(안녕|고마워|감사|thanks?|thank you|응|ㅇㅇ|네|넵|오키|좋아|하이)(?![\p{L}\p{N}])/iu.test(cleaned) ||
    /(고맙|감사|반가워|수고|파이팅|화이팅|먹고\s*싶|전해줘|말해줘)/i.test(cleaned);
}

function buildFallbackVerifiedResponse(
  userPrompt: string,
  sources: readonly VerifiedSource[],
  toolInsights: readonly string[]
): string {
  const korean = containsHangul(userPrompt);
  const header = korean
    ? "조회한 결과를 정리해 드릴게요. 아래 인사이트와 출처를 함께 확인해 보세요."
    : "Here's what I found. See the insights and sources below.";

  if (toolInsights.length === 0) {
    return header;
  }

  const title = korean ? "💡 인사이트" : "💡 Insights";
  const insightLines = toolInsights.slice(0, 5).map((insight) => `- ${insight}`).join("\n");
  return `${header}\n\n${title}\n${insightLines}`;
}

function maybeAppendToolInsights(output: string, context: ResponseFilterContext): string {
  if ((context.toolsUsed ?? []).length === 0 || isCasualPromptText(joinUserMessages(context.input.messages))) {
    return output;
  }
  if (hasInsightMarker(output)) {
    return output;
  }

  const insightLines = buildVerifiedInsightLines(context);

  if (!insightLines) {
    return output;
  }

  return `${output.trimEnd()}\n\n${containsHangul(joinUserMessages(context.input.messages)) ? "💡 인사이트" : "💡 Insights"}\n${insightLines}`.trim();
}

function buildVerifiedInsightLines(context: ResponseFilterContext): string {
  const insights = context.toolInsights ?? [];

  if (insights.length > 0) {
    return insights.slice(0, 5).map((insight) => `- ${insight}`).join("\n");
  }

  const sources = context.verifiedSources ?? [];

  if (sources.length === 0) {
    return "";
  }

  const titles = sources.slice(0, 3).map((source) => source.title).filter((title) => title.trim().length > 0);

  if (titles.length === 0) {
    return `- 확인된 출처 ${sources.length}건을 찾았습니다.`;
  }

  return `- 확인된 출처 ${sources.length}건: ${titles.join(", ")}`;
}

function hasInsightMarker(output: string): boolean {
  return /💡|:bulb:|인사이트|insights?|분석|권장|추천/i.test(output);
}

function buildVerifiedSourcesBlock(userPrompt: string, sources: readonly VerifiedSource[]): string {
  // Source-trust segregation: every entry here is by construction TOOL-FETCHED
  // external data (URLs extracted from tool output), never the user's own
  // notes — name that provenance in the heading so a grounded-looking citation
  // to an outside source is never mistaken for "from my own data"
  // (grounded≠true: the gate checks claim↔source match, not source veracity).
  const heading = containsHangul(userPrompt)
    ? "출처 (외부 — 도구가 가져온 정보, 내 노트 아님)"
    : "Sources (external — tool-fetched, not your own notes)";
  const lines = sources.map((source) => `- [${escapeMarkdownTitle(source.title)}](${source.url})`);
  return `${heading}\n${lines.join("\n")}`;
}

function hasEquivalentSourceBlock(output: string, sources: readonly VerifiedSource[]): boolean {
  return sources.every((source) => output.includes(source.url));
}

function escapeMarkdownTitle(title: string): string {
  return title.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function containsHangul(text: string): boolean {
  return /[가-힣]/u.test(text);
}
