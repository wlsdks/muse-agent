import type { ModelResponse } from "@muse/model";
import { isRecord, joinUserMessages, withResponseFilterRaw } from "./internals.js";
import type { ResponseFilterStage } from "./types.js";

/**
 * Self-contained response-filter factories.
 *
 * These filters depend only on the public response-filter contract, the
 * `joinUserMessages` helper, and the `withResponseFilterRaw` helper. Filters
 * with deeper dependencies (markdown table conversion, verified-source
 * extraction, tool-result quality audit, etc.) still live in `index.ts`
 * pending further extraction.
 */

export function createMaxLengthResponseFilter(options: { readonly maxLength?: number } = {}): ResponseFilterStage {
  const maxLength = Math.max(0, Math.floor(options.maxLength ?? 0));

  return {
    apply: (response: ModelResponse) => {
      if (maxLength <= 0 || response.output.length <= maxLength) {
        return response;
      }

      return {
        ...response,
        output: `${response.output.slice(0, maxLength)}\n\n[Response truncated]`,
        raw: {
          ...(isRecord(response.raw) ? response.raw : {}),
          museResponseFilter: {
            id: "max-length-response-filter",
            maxLength
          }
        }
      };
    },
    id: "max-length-response-filter"
  };
}

export function createSanitizedTextResponseFilter(): ResponseFilterStage {
  return {
    apply: (response: ModelResponse) => {
      if (!response.output.includes("[SANITIZED]")) {
        return response;
      }

      const output = response.output
        .replace(/^\s*\[SANITIZED\]\s*$\n?/gm, "")
        .replaceAll("[SANITIZED]", "(보안 처리됨)")
        .replace(/\n{3,}/gu, "\n\n")
        .trim();

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "sanitized-text-response-filter")
      };
    },
    id: "sanitized-text-response-filter"
  };
}

export function createSlackUserIdMaskResponseFilter(): ResponseFilterStage {
  const rawSlackUserIdPattern = /(?<![@\w])`?(U[A-Z0-9]{8,})`?(?![A-Za-z0-9])/gu;

  return {
    apply: (response: ModelResponse) => {
      if (response.output.trim().length === 0) {
        return response;
      }

      const output = response.output.replace(rawSlackUserIdPattern, "<@$1>");

      if (output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: {
          ...(isRecord(response.raw) ? response.raw : {}),
          museResponseFilter: {
            id: "slack-user-id-mask-response-filter"
          }
        }
      };
    },
    id: "slack-user-id-mask-response-filter"
  };
}

export function createInternalBrandMaskResponseFilter(): ResponseFilterStage {
  const patterns: readonly (readonly [RegExp, string])[] = [
    [/\*\*?Reactor\s*\(\s*Reactor\s*\)\*\*?/gu, "*Reactor*"],
    [/Reactor\s*\(\s*Reactor\s*\)/gu, "Reactor"],
    [/^\s*[*\-•]\s*\*{0,2}(?:언어|프레임워크|Language|Framework)[\s:]*\*{0,2}[^\n]*Kotlin[^\n]*$/gmu, ""],
    [/^\s*[*\-•]\s*\*{0,2}(?:언어|프레임워크|Language|Framework)[\s:]*\*{0,2}[^\n]*(?:Spring)[^\n]*$/gmu, ""],
    [/\*{0,2}(?:Kotlin\s*\/\s*Spring\s*Boot|Kotlin과\s*Spring\s*Boot)(?:\s*기반(?:의|으로)?)?\*{0,2}/gu, ""],
    [/\*{0,2}(?:Spring\s*AI|Spring\s*Boot)(?:\s*기반(?:의|으로)?)?\*{0,2}\s*/gu, ""],
    [/,\s*,/gu, ","],
    [/\s+\./gu, "."]
  ];

  return {
    apply: (response: ModelResponse) => {
      if (response.output.trim().length === 0) {
        return response;
      }

      let output = response.output;

      for (const [pattern, replacement] of patterns) {
        output = output.replace(pattern, replacement);
      }

      output = output.replace(/ {2,}/gu, " ").replace(/\n{3,}/gu, "\n\n").trimEnd();

      if (output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: {
          ...(isRecord(response.raw) ? response.raw : {}),
          museResponseFilter: {
            id: "internal-brand-mask-response-filter"
          }
        }
      };
    },
    id: "internal-brand-mask-response-filter"
  };
}

export function createFabricationRequestRefusalFilter(): ResponseFilterStage {
  return {
    apply: (response, context) => {
      const prompt = joinUserMessages(context.input.messages).toLowerCase();
      const asksToInvent = ["지어서", "지어내", "임의로", "만들어서", "make up", "fabricate"].some((term) =>
        prompt.includes(term)
      );
      const admitsMissing = ["없는", "문서에 없는", "근거 없이", "without source", "not in docs"].some((term) =>
        prompt.includes(term)
      );
      const asksSecret = ["비밀 문서", "비공개 문서", "secret document"].some((term) => prompt.includes(term));
      const missingOrDiscovery = ["없는", "찾아", "검색", "요약"].some((term) => prompt.includes(term));

      if (!(asksToInvent && admitsMissing) && !(asksSecret && missingOrDiscovery)) {
        return response;
      }

      return {
        ...response,
        output: [
          "요청하신 내용은 확인된 공식 문서나 접근 권한이 있는 출처가 없으면 제공할 수 없습니다.",
          "존재하지 않거나 비공개일 수 있는 문서는 찾아내거나 지어내서 요약하지 않습니다."
        ].join(" "),
        raw: withResponseFilterRaw(response, "fabrication-request-refusal-filter")
      };
    },
    id: "fabrication-request-refusal-filter"
  };
}
