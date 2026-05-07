import type { ModelResponse } from "@muse/model";
import {
  normalizeStructuredOutput,
  sanitizeSourceBlocks,
  type StructuredOutputFormat
} from "@muse/policy";
import {
  isRecord,
  joinUserMessages,
  splitOnCodeFences,
  transformMarkdownText,
  withResponseFilterRaw
} from "./internals.js";
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

export function createMarkdownStripResponseFilter(): ResponseFilterStage {
  return {
    apply: (response: ModelResponse) => {
      if (response.output.trim().length === 0) {
        return response;
      }

      const output = splitOnCodeFences(response.output)
        .map((segment) => (segment.isCode ? segment.text : transformMarkdownText(segment.text)))
        .join("");

      if (output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "markdown-strip-response-filter")
      };
    },
    id: "markdown-strip-response-filter"
  };
}

export function createGreetingStripResponseFilter(): ResponseFilterStage {
  const leadingGreetingPattern =
    /^(안녕하세요|안녕|반가워요|반갑습니다|반갑네요|하이)(?:[,，]?\s*[^\n!?.]{0,25}[님씨])?[!?.]\s*/u;
  const followupGreetingPattern =
    /^(반갑습니다|반가워요|반갑네요|만나서\s*반가워요|만나서\s*반갑습니다|만나서\s*정말\s*반가워요|만나서\s*정말\s*기쁩니다|좋은\s*아침이에요|좋은\s*저녁이에요)[!?.]\s*/u;

  return {
    apply: (response: ModelResponse) => {
      if (response.output.trim().length === 0) {
        return response;
      }

      const output = response.output
        .replace(leadingGreetingPattern, "")
        .replace(followupGreetingPattern, "")
        .trimStart();

      if (output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "greeting-strip-response-filter")
      };
    },
    id: "greeting-strip-response-filter"
  };
}

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

export function createStructuredOutputResponseFilter(options: {
  readonly format?: StructuredOutputFormat;
  readonly metadataKey?: string;
} = {}): ResponseFilterStage {
  const metadataKey = options.metadataKey ?? "responseFormat";

  return {
    apply: (response, context) => {
      const format = options.format ?? readStructuredOutputFormat(context.input.metadata?.[metadataKey]);

      if (!format) {
        return response;
      }

      const result = normalizeStructuredOutput(response.output, format);

      if (!result.normalized) {
        return response;
      }

      return {
        ...response,
        output: result.content,
        raw: {
          ...(isRecord(response.raw) ? response.raw : {}),
          museResponseFilter: {
            format,
            id: "structured-output-response-filter"
          }
        }
      };
    },
    id: "structured-output-response-filter"
  };
}

export function createReleaseRiskDataGapResponseFilter(): ResponseFilterStage {
  const cautionMessage = "Bitbucket 데이터 집계 경고가 있어 전체 릴리스 위험도는 확정하지 않습니다.";
  const dataGapPattern =
    /(Bitbucket|비트버킷)[^\n.]*(집계|데이터|조회)[^\n.]*(실패|경고|문제|오류)|(실패|경고|문제|오류)[^\n.]*(Bitbucket|비트버킷)[^\n.]*(집계|데이터|조회)/i;
  const overconfidentRiskPattern =
    /(위험(?:도|도가| 점수)?[^\n.]*(?:낮|0\s*점)|위험\s*수준[^\n.]*(?:낮|low)|특별한\s*위험\s*신호[^\n.]*(?:없|감지되지)|심각한\s*위험\s*신호[^\n.]*(?:없|감지되지)|Jira\s*이슈와\s*Bitbucket\s*PR\s*활동[^\n.]*(?:없|없는)|특이사항[^\n.]*(?:없|발견되지)[^\n.]*(?:큰\s*문제|문제\s*없)|경고[^\n.]*(?:전체\s*)?위험도[^\n.]*(?:영향을?\s*미치지\s*않|영향\s*없)|릴리스\s*준비[^\n.]*(?:완료|끝)|(?:계획된\s*)?릴리스\s*체크리스트[^\n.]*(?:진행|계속)|전반적인\s*위험도[^\n.]*(?:낮음|low))/i;
  const cautionPattern = /전체\s*릴리스\s*위험도는\s*확정하지\s*않|release\s*risk[^\n.]*not\s*conclusive/i;

  return {
    apply: (response, context) => {
      if (!(context.toolsUsed ?? []).includes("work_release_risk_digest")) {
        return response;
      }
      if (!dataGapPattern.test(response.output) || !overconfidentRiskPattern.test(response.output)) {
        return response;
      }

      const output = response.output
        .split("\n")
        .map((line) => removeOverconfidentReleaseFragments(line, overconfidentRiskPattern))
        .filter((line) => line.trim().length > 0)
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (output.length === 0) {
        return response;
      }

      const finalOutput = cautionPattern.test(output) ? output : `${cautionMessage}\n\n${output}`;

      return {
        ...response,
        output: finalOutput,
        raw: withResponseFilterRaw(response, "release-risk-data-gap-response-filter")
      };
    },
    id: "release-risk-data-gap-response-filter"
  };
}

function readStructuredOutputFormat(value: unknown): StructuredOutputFormat | undefined {
  return value === "json" || value === "yaml" ? value : undefined;
}

function removeOverconfidentReleaseFragments(line: string, pattern: RegExp): string {
  if (!pattern.test(line)) {
    return line;
  }

  const indent = line.match(/^\s*/)?.[0] ?? "";
  const fragments = line.trim().split(/(?<=[.!?])\s+/).filter((fragment) => fragment.trim().length > 0);
  const kept = fragments.filter((fragment) => !pattern.test(fragment));
  return kept.length === 0 ? "" : `${indent}${kept.join(" ")}`;
}
