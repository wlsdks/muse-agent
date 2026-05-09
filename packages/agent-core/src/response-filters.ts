import type { ModelResponse } from "@muse/model";
import {
  normalizeStructuredOutput,
  type StructuredOutputFormat
} from "@muse/policy";
import {
  extractApologyLead,
  isRecord,
  isSignificantCountMismatch,
  joinUserMessages,
  resolveActualResponseCount,
  splitOnCodeFences,
  transformMarkdownText,
  withResponseFilterRaw
} from "./internals.js";
import type { ResponseFilterStage } from "./types.js";

/**
 * Self-contained response-filter factories.
 *
 * Verified-sources filters live in `./response-filters-verified-sources.js`
 * and are re-exported below to keep the public surface stable.
 */

export {
  createSourceBlockResponseFilter,
  createVerifiedSourcesResponseFilter
} from "./response-filters-verified-sources.js";

export {
  createCasualLureStripResponseFilter,
  createEnglishCasualLureStripResponseFilter
} from "./response-filters-casual-lure-strip.js";


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

/**
 * English counterpart to `createGreetingStripResponseFilter` (which is
 * Korean-pattern-only). Strips a single leading greeting like "Hi there!",
 * "Hello!", "Good morning!", "Greetings,". Both filters can run in the same
 * chain — they target disjoint patterns, so neither cancels the other.
 */
export function createEnglishGreetingStripResponseFilter(): ResponseFilterStage {
  const leadingGreetingPattern =
    /^\s*(?:Hi|Hello|Hey|Howdy|Greetings|Hiya)(?:\s+(?:there|all|everyone|team|folks|y'all))?(?:,\s*\w{1,20})?[!?.]\s+/iu;
  const goodTimeOfDayPattern = /^\s*Good\s+(?:morning|afternoon|evening|day|night)(?:\s+\w{1,20})?[!?.]\s+/iu;
  const niceToMeetPattern = /^\s*(?:Nice|Pleased|Good|Glad)\s+to\s+(?:meet|see)\s+you[!?.]\s+/iu;

  return {
    apply: (response: ModelResponse) => {
      if (response.output.trim().length === 0) {
        return response;
      }

      const output = response.output
        .replace(leadingGreetingPattern, "")
        .replace(goodTimeOfDayPattern, "")
        .replace(niceToMeetPattern, "")
        .trimStart();

      if (output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "english-greeting-strip-response-filter")
      };
    },
    id: "english-greeting-strip-response-filter"
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

export interface SanitizedTextResponseFilterOptions {
  /**
   * Inline replacement for `[SANITIZED]` markers that survived guard
   * stages. Defaults to "(보안 처리됨)" so existing Korean operator UX
   * is unchanged. English deployments typically pass "(redacted)".
   */
  readonly inlineReplacement?: string;
}

export function createSanitizedTextResponseFilter(
  options: SanitizedTextResponseFilterOptions = {}
): ResponseFilterStage {
  const inlineReplacement = options.inlineReplacement ?? "(보안 처리됨)";

  return {
    apply: (response: ModelResponse) => {
      if (!response.output.includes("[SANITIZED]")) {
        return response;
      }

      const output = response.output
        .replace(/^\s*\[SANITIZED\]\s*$\n?/gm, "")
        .replaceAll("[SANITIZED]", inlineReplacement)
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

export interface FabricationRequestRefusalFilterOptions {
  /**
   * Lowercase substring terms that mean the user is asking the model to
   * invent / make up content. Detection requires both an `invent` term AND
   * a `missing` term to appear in the prompt (or the secret-doc combo).
   */
  readonly inventTerms?: readonly string[];
  /** Lowercase substring terms that mean the user admits the source is missing. */
  readonly missingTerms?: readonly string[];
  /** Lowercase substring terms that name a secret / private document. */
  readonly secretTerms?: readonly string[];
  /** Lowercase substring terms that pair with `secretTerms` to trigger the refusal. */
  readonly missingOrDiscoveryTerms?: readonly string[];
  /** Refusal text to emit instead of the model's output. */
  readonly refusalText?: string;
}

const fabricationDefaults = {
  inventTerms: ["지어서", "지어내", "임의로", "만들어서", "make up", "fabricate"],
  missingOrDiscoveryTerms: ["없는", "찾아", "검색", "요약"],
  missingTerms: ["없는", "문서에 없는", "근거 없이", "without source", "not in docs"],
  refusalText: [
    "요청하신 내용은 확인된 공식 문서나 접근 권한이 있는 출처가 없으면 제공할 수 없습니다.",
    "존재하지 않거나 비공개일 수 있는 문서는 찾아내거나 지어내서 요약하지 않습니다."
  ].join(" "),
  secretTerms: ["비밀 문서", "비공개 문서", "secret document"]
} as const;

export function createFabricationRequestRefusalFilter(
  options: FabricationRequestRefusalFilterOptions = {}
): ResponseFilterStage {
  const inventTerms = options.inventTerms ?? fabricationDefaults.inventTerms;
  const missingTerms = options.missingTerms ?? fabricationDefaults.missingTerms;
  const secretTerms = options.secretTerms ?? fabricationDefaults.secretTerms;
  const missingOrDiscoveryTerms = options.missingOrDiscoveryTerms ?? fabricationDefaults.missingOrDiscoveryTerms;
  const refusalText = options.refusalText ?? fabricationDefaults.refusalText;

  return {
    apply: (response, context) => {
      const prompt = joinUserMessages(context.input.messages).toLowerCase();
      const asksToInvent = inventTerms.some((term) => prompt.includes(term));
      const admitsMissing = missingTerms.some((term) => prompt.includes(term));
      const asksSecret = secretTerms.some((term) => prompt.includes(term));
      const missingOrDiscovery = missingOrDiscoveryTerms.some((term) => prompt.includes(term));

      if (!(asksToInvent && admitsMissing) && !(asksSecret && missingOrDiscovery)) {
        return response;
      }

      return {
        ...response,
        output: refusalText,
        raw: withResponseFilterRaw(response, "fabrication-request-refusal-filter")
      };
    },
    id: "fabrication-request-refusal-filter"
  };
}

export interface ZeroResultOverclaimResponseFilterOptions {
  /**
   * Optional gate on tool name prefixes — when non-empty, the filter
   * only fires if at least one tool used in the run had a matching
   * prefix. Default `[]` means no gate (the filter looks at every
   * response). Previous Atlassian prefix list (`jira_`, `confluence_`,
   * `bitbucket_`, `work_`) is no longer the default — operators who
   * want it can pass it explicitly.
   */
  readonly workspaceToolPrefixes?: readonly string[];
  /**
   * Pattern that must match somewhere in the response to indicate a
   * zero-result outcome. Default is the Korean pattern set; English
   * deployments typically pass an English-pattern variant.
   */
  readonly zeroResultPattern?: RegExp;
  /**
   * Pattern matched against each line — lines matching this pattern
   * are stripped from the response when the zero-result + tool-prefix
   * gates also pass.
   */
  readonly overclaimPattern?: RegExp;
}

const zeroResultDefaults = {
  overclaimPattern:
    /(순조|원활|잘\s*(?:관리|되고)|모든\s*(?:작업|이슈)[^.\n]*(?:완료|정리)|활발한\s*작업이\s*진행되고\s*있지|활동\s*중인\s*이슈가\s*없는)/i,
  zeroResultPattern: /(0\s*건|검색 결과 0건|조회된 이슈가 없어|이슈는 없습니다|이슈가 없습니다)/i
} as const;

export function createZeroResultOverclaimResponseFilter(
  options: ZeroResultOverclaimResponseFilterOptions = {}
): ResponseFilterStage {
  const prefixes = options.workspaceToolPrefixes ?? [];
  const zeroResultPattern = options.zeroResultPattern ?? zeroResultDefaults.zeroResultPattern;
  const overclaimPattern = options.overclaimPattern ?? zeroResultDefaults.overclaimPattern;

  return {
    apply: (response, context) => {
      if (prefixes.length > 0) {
        const toolsUsed = context.toolsUsed ?? [];
        const hasWorkspaceTool = toolsUsed.some((tool) =>
          prefixes.some((prefix) => tool.startsWith(prefix))
        );
        if (!hasWorkspaceTool) {
          return response;
        }
      }

      if (!zeroResultPattern.test(response.output) || !overclaimPattern.test(response.output)) {
        return response;
      }

      const output = response.output
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          return trimmed.length === 0 || !overclaimPattern.test(trimmed);
        })
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd();

      if (output.length === 0 || output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "zero-result-overclaim-response-filter")
      };
    },
    id: "zero-result-overclaim-response-filter"
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

function readStructuredOutputFormat(value: unknown): StructuredOutputFormat | undefined {
  return value === "json" || value === "yaml" ? value : undefined;
}

export function createToolResultQualityAuditFilter(): ResponseFilterStage {
  const apologyLeadPatterns = [
    "죄송합니다",
    "jira 계정",
    "jira에서",
    "계정을 확인할 수 없",
    "연동이 필요",
    "확인할 수 없어",
    "정보가 변경되었",
    "가져올 수 없",
    "확인할 수 없습니다",
    "연동 상태를 확인",
    "bitbucket 계정"
  ];

  return {
    apply: (response, context) => {
      if ((context.toolsUsed ?? []).length === 0 || (context.verifiedSources ?? []).length === 0) {
        return response;
      }
      if (response.output.trim().length === 0) {
        return response;
      }

      const leadingApology = extractApologyLead(response.output, apologyLeadPatterns);

      if (!leadingApology) {
        return response;
      }

      const rest = response.output.slice(response.output.indexOf(leadingApology) + leadingApology.length).trimStart();

      if (rest.length === 0) {
        return response;
      }

      const output = rest.trimStart().startsWith("💡") ? rest : `조회한 결과를 정리해드릴게요.\n\n${rest}`;

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "tool-result-quality-audit-filter")
      };
    },
    id: "tool-result-quality-audit-filter"
  };
}

export function createResponseCountInjectionFilter(): ResponseFilterStage {
  const countInsightPattern = /(검색 결과 0건|총 \d{1,4}건)/;
  const contentHasCountPattern = /(\d{1,4}\s*건|0건|결과 없|찾지 못|확인되지 않|등록되지 않|발견되지 않)/;

  return {
    apply: (response, context) => {
      if (response.output.trim().length === 0 || (context.toolsUsed ?? []).length === 0) {
        return response;
      }

      const countInsight = (context.toolInsights ?? []).find((insight) => countInsightPattern.test(insight));

      if (!countInsight || contentHasCountPattern.test(response.output)) {
        return response;
      }

      return {
        ...response,
        output: `${countInsight}\n\n${response.output}`,
        raw: withResponseFilterRaw(response, "response-count-injection-filter")
      };
    },
    id: "response-count-injection-filter"
  };
}

export function createResponseCountConsistencyFilter(): ResponseFilterStage {
  const assertionPatterns = [
    /총\s*(\d{1,4})\s*건/g,
    /(\d{1,4})\s*건\s*(?:있|확인|찾|검색|매칭|발견)/g,
    /(\d{1,4})\s*건\s*입니다/g,
    /총\s*(\d{1,4})\s*개(?!월|국|년|주|일|시간|분|초|명|장|회|차|배|면|층|점|대)/g,
    /found\s+(\d{1,4})\s+(?:results?|items?|matches?|issues?|docs?)/gi,
    /(\d{1,4})\s+(?:results?|items?|matches?|issues?|docs?)\s+found/gi
  ];

  return {
    apply: (response, context) => {
      if (response.output.trim().length === 0 || (context.toolsUsed ?? []).length === 0) {
        return response;
      }
      if ((context.toolsUsed ?? []).includes("work_release_risk_digest")) {
        return response;
      }

      const actualCount = resolveActualResponseCount(response.output, context.verifiedSources ?? []);

      if (actualCount < 0) {
        return response;
      }

      let output = response.output;

      for (const pattern of assertionPatterns) {
        output = output.replace(pattern, (match, assertedText: string) => {
          const asserted = Number.parseInt(assertedText, 10);

          if (!Number.isFinite(asserted) || !isSignificantCountMismatch(asserted, actualCount)) {
            return match;
          }

          return match.replace(assertedText, String(actualCount));
        });
      }

      if (output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "response-count-consistency-filter")
      };
    },
    id: "response-count-consistency-filter"
  };
}

