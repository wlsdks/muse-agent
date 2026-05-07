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
  splitPreservingSentencePunctuation,
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

export function createCasualLureStripResponseFilter(): ResponseFilterStage {
  const casualMaxChars = 500;
  const reactionOnlyTools = new Set(["add_reaction"]);
  const suggestionBlockPattern =
    /(\n+|(?<=[.!?])\s+)(예를\s*들어\s+)?(\*\*)?\s*(?:[\p{So}\p{Sk}]{0,3}\s*)?(함께|이렇게|이런\s*건|이런\s*걸|이런\s*것들?|이런\s*질문|아래처럼|궁금하신|궁금한|다음에\s*\S{1,6}|추가로|도움이\s*필요|어떤|오늘의)[^\n]{0,40}(볼까요|어떠세요|해\s*보세요|활용해\s*보세요|있나요|있으신가요|물어보세요|물어보셔도|물어보실\s*수\s*있어요|도와드릴까요|좋아요|하신가요|하실까요|수\s*있어요|보세요|드릴까요|골라주세요)[?!.:]\s*(\*\*)?\s+((\s*[*\-0-9.][^\n]*|\s*["'][^\n]*)\n?){2,}$/su;
  const quotedBulletTailPattern = /\n\n+([^\n]{0,80}\n)?(\s*[*\-]\s*[*`]*["'][^\n]*\n?){2,}$/su;
  const trailingSymbolPattern = /[\p{So}\p{Sk}\p{Sc}\s~*_:)(-]+$/u;
  const workLurePatterns = [
    /(지라|jira|컨플루언스|confluence|비트버킷|bitbucket)[^\n]*?(확인|조회|검색|요약|정리|찾|알려)/i,
    /업무[^\n]*?(이슈|문서|PR|티켓)[^\n]*?(확인|검색|조회)/,
    /(이슈|문서|티켓|PR)\s*(확인|검색|조회)[^\n]{0,20}(나|이나)[^\n]{0,30}(문서|이슈|PR)\s*(검색|확인|조회)/,
    /(도와드릴|해드릴|챙겨드릴|추가로\s*도와드릴|살펴\s*드릴|필요하신|필요한|알려드릴|궁금하신)[^\n]{0,30}(지라|jira|컨플루언스|confluence|비트버킷|bitbucket|이슈|문서|PR|티켓)/i,
    /업무\s*(조회|정리|확인|검색|요약|지원|관리|처리)/i,
    /도움이\s*필요(하신|하실|한|하시?면)?[^\n]{0,30}(업무|이슈|문서|PR|티켓|있으신가요|있으시면|하시면|말씀해|말해|언제든|물어봐|문의)/i,
    /(이슈|문서|PR|티켓|프로젝트)[^\n]{0,20}(궁금하신가요|궁금하시면|필요하신가요|필요하시면|있으신가요|있으시면|있나요|없나요|챙겨야)/i,
    /(혹시|만약)[^\n]{0,40}(있다면|있으시면|필요하시면|있으면)[^\n]{0,40}(말씀해|알려|얘기해|들려|문의)/i,
    /(무엇을|어떤\s*걸|뭘|어떤\s*업무를)\s*도와드릴까요/i
  ];
  const lurePatterns = [
    /(도와드릴|찾아드릴|정리해\s*드릴|보여드릴|확인해\s*드릴|알려\s*드릴|봐드릴|체크해\s*드릴|브리핑해\s*드릴|요약해\s*드릴).{0,120}[?!.]\s*\$?\s*$/s,
    /혹시.{0,60}(필요하시?면|있으시?면|있을까요).{0,80}[?!.]\s*\$?\s*$/s,
    /(궁금|문의|얘기|질문).{0,50}언제든.{0,80}[?!.]\s*\$?\s*$/s,
    /말씀해\s*주세요[!.]\s*$/,
    /(무엇을|어떤\s*걸|뭘)\s*도와드릴까요[?]\s*$/,
    /더\s*궁금.{0,20}[?]\s*$/,
    /(지금\s*바로\s*)?확인.{0,30}(싶은|하고\s*싶).{0,50}[?]\s*$/s,
    /(언제든|편하게)\s*불러주세요[!.]\s*$/,
    /(계속|이어|시작)해?\s*(드릴까요|볼까요|할까요)[?]\s*$/,
    /(어떨까요|어떠세요|해보시겠어요|해보시는\s*건\s*어때[요]?|\s물어보시?는\s*건)[?!.]\s*$/,
    /예를\s*들[어면].{0,200}[?!.]\s*$/s,
    /(물어봐\s*주세요|말씀하시거나|말씀해\s*주시거나|얘기해\s*주세요)[!.?]\s*$/,
    /^\s*\(?\s*예\s*[:：].{0,200}\)?\s*$/s,
    /(후속\s*질문으로|예시\s*질문|질문\s*예시|예시로[는는]?)[^\n]{0,150}[!.?]\s*$/
  ];

  return {
    apply: (response, context) => {
      if (response.output.trim().length === 0 || response.output.length > casualMaxChars) {
        return response;
      }

      const toolsUsed = context.toolsUsed ?? [];
      const hasWorkTool = toolsUsed.some((tool) => !reactionOnlyTools.has(tool));

      if (hasWorkTool) {
        return response;
      }

      let preStripped = response.output.replace(suggestionBlockPattern, "").trimEnd();
      preStripped = preStripped.replace(quotedBulletTailPattern, "").trimEnd();

      const sentences = splitPreservingSentencePunctuation(preStripped);

      if (sentences.length === 0) {
        return response;
      }

      const withoutWorkLure = sentences.filter((sentence) => !workLurePatterns.some((pattern) => pattern.test(sentence)));
      const remaining = [...withoutWorkLure];
      let dropCount = 0;

      while (remaining.length > 0 && dropCount < 3) {
        const last = remaining.at(-1) ?? "";
        const normalized = last.trimEnd().replace(trailingSymbolPattern, "").trimEnd();

        if (!lurePatterns.some((pattern) => pattern.test(normalized))) {
          break;
        }

        remaining.pop();
        dropCount += 1;
      }

      if (remaining.length === 0) {
        return {
          ...response,
          output: response.output.trimEnd(),
          raw: withResponseFilterRaw(response, "casual-lure-strip-response-filter")
        };
      }

      const preStripChanged = preStripped.length !== response.output.trimEnd().length;

      if (!preStripChanged && remaining.length === sentences.length && dropCount === 0) {
        return response;
      }

      const output = remaining.join(" ").trimEnd();

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "casual-lure-strip-response-filter")
      };
    },
    id: "casual-lure-strip-response-filter"
  };
}

export function createPolicyStrongPriorWarningFilter(): ResponseFilterStage {
  const disclaimer =
    ":warning: *참고*: 위 내용은 사내 Confluence 문서에서 확인된 정보가 아닙니다. " +
    "실제 사내 규정은 Confluence 또는 인사팀에 직접 확인해 주세요.";
  const policyQueryPattern =
    /휴가|연차|반차|병가|경조사|출산휴가|육아휴직|재택근무|야근|수당|급여|상여금|명절|떡값|출장비|경비|정산|근태|복리후생|복지|사내\s*정책|회사\s*정책|규정|가이드라인|인사\s*규정|취업\s*규칙|윤리|컴플라이언스/i;
  const genericFallbackPatterns = [
    /회사마다\s*다를?/,
    /회사마다\s*달라/,
    /근로기준법(에|상|\s*에\s*따르면|\s*에\s*따라)/,
    /고용보험법(에|상|\s*에\s*따르면|\s*에\s*따라)/,
    /법적으로|법에\s*따라|법\s*상/,
    /보통\s*회사들은/,
    /일반적으로\s*(회사|기업|정책|\d|수당|휴가)/,
    /기본적으로\s*\d+\s*일/,
    /\d+\s*일까지\s*(사용|쓸\s*수)/,
    /\d+\s*일\s*이상은?\s*출산\s*후에/
  ];
  const confluenceUrlPattern = /https?:\/\/[^\s]*\.atlassian\.net\/wiki\//i;

  return {
    apply: (response, context) => {
      if (response.output.trim().length < 20) {
        return response;
      }

      const userPrompt = joinUserMessages(context.input.messages);

      if (!policyQueryPattern.test(userPrompt)) {
        return response;
      }
      if (!genericFallbackPatterns.some((pattern) => pattern.test(response.output))) {
        return response;
      }
      if ((context.toolsUsed ?? []).some((tool) => tool.startsWith("confluence_"))) {
        return response;
      }
      if (confluenceUrlPattern.test(response.output)) {
        return response;
      }

      return {
        ...response,
        output: `${response.output.trimEnd()}\n\n${disclaimer}`,
        raw: withResponseFilterRaw(response, "policy-strong-prior-warning-filter")
      };
    },
    id: "policy-strong-prior-warning-filter"
  };
}

export function createZeroResultOverclaimResponseFilter(): ResponseFilterStage {
  const zeroResultPattern = /(0\s*건|검색 결과 0건|조회된 이슈가 없어|이슈는 없습니다|이슈가 없습니다)/i;
  const overclaimPattern =
    /(순조|원활|잘\s*(?:관리|되고)|모든\s*(?:작업|이슈)[^.\n]*(?:완료|정리)|활발한\s*작업이\s*진행되고\s*있지|활동\s*중인\s*이슈가\s*없는)/i;

  return {
    apply: (response, context) => {
      const toolsUsed = context.toolsUsed ?? [];
      const hasWorkspaceTool = toolsUsed.some((tool) =>
        ["jira_", "work_", "bitbucket_", "confluence_"].some((prefix) => tool.startsWith(prefix))
      );

      if (!hasWorkspaceTool || !zeroResultPattern.test(response.output) || !overclaimPattern.test(response.output)) {
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
