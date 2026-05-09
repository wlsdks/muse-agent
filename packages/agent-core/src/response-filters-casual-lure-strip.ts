import {
  splitPreservingSentencePunctuation,
  withResponseFilterRaw
} from "./internals.js";
import type { ResponseFilterStage } from "./types.js";

/**
 * Casual-lure strip response filters.
 *
 * Two factories — Korean and English — extracted from
 * `response-filters.ts` so the lure regex tables stay together
 * with the loop that uses them. The filters target disjoint
 * patterns and can run in the same chain.
 */

export function createCasualLureStripResponseFilter(): ResponseFilterStage {
  const casualMaxChars = 500;
  const reactionOnlyTools = new Set(["add_reaction"]);
  const suggestionBlockPattern =
    /(\n+|(?<=[.!?])\s+)(예를\s*들어\s+)?(\*\*)?\s*(?:[\p{So}\p{Sk}]{0,3}\s*)?(함께|이렇게|이런\s*건|이런\s*걸|이런\s*것들?|이런\s*질문|아래처럼|궁금하신|궁금한|다음에\s*\S{1,6}|추가로|도움이\s*필요|어떤|오늘의)[^\n]{0,40}(볼까요|어떠세요|해\s*보세요|활용해\s*보세요|있나요|있으신가요|물어보세요|물어보셔도|물어보실\s*수\s*있어요|도와드릴까요|좋아요|하신가요|하실까요|수\s*있어요|보세요|드릴까요|골라주세요)[?!.:]\s*(\*\*)?\s+((\s*[*\-0-9.][^\n]*|\s*["'][^\n]*)\n?){2,}$/su;
  const quotedBulletTailPattern = /\n\n+([^\n]{0,80}\n)?(\s*[*\-]\s*[*`]*["'][^\n]*\n?){2,}$/su;
  const trailingSymbolPattern = /[\p{So}\p{Sk}\p{Sc}\s~*_:)(-]+$/u;
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

      const remaining = [...sentences];
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

/**
 * English counterpart to `createCasualLureStripResponseFilter` (which is
 * Korean-pattern-only). Strips trailing closing pleasantries on a short
 * no-tools-used response: "Let me know if you need anything else.",
 * "Hope that helps!", "Anything else I can help with?", suggestion-block
 * tails, and bullet-list lure followups. Both filters can run together —
 * they target disjoint patterns.
 */
export function createEnglishCasualLureStripResponseFilter(): ResponseFilterStage {
  const casualMaxChars = 500;
  const reactionOnlyTools = new Set(["add_reaction"]);
  const trailingSymbolPattern = /[\p{So}\p{Sk}\p{Sc}\s~*_:)(-]+$/u;
  const lurePatterns: readonly RegExp[] = [
    /(?:I(?:'m| am)?\s+(?:happy|glad)|I'?d\s+be\s+(?:happy|glad))\s+to\s+(?:help|assist).{0,120}[?!.]\s*$/iu,
    /(?:Let\s+me\s+know|Just\s+let\s+me\s+know|Feel\s+free\s+to|Don't\s+hesitate\s+to|Please\s+(?:let\s+me\s+know|reach\s+out)).{0,120}[?!.]\s*$/iu,
    /(?:Hope\s+(?:this|that)\s+(?:helps|works)|Hope\s+it\s+helps)[!.]?\s*$/iu,
    /(?:Anything\s+else|Is\s+there\s+anything\s+else|Any(?:thing)?\s+(?:more|other)).{0,80}[?!.]\s*$/iu,
    /(?:What\s+(?:would\s+you\s+like|else\s+would\s+you|can\s+I\s+help)).{0,80}[?!.]\s*$/iu,
    /^\s*Cheers[!.]?\s*$/iu,
    /^\s*Best(?:\s+regards)?[!.]?\s*$/iu,
    /(?:Reach\s+out|Get\s+in\s+touch|Drop\s+me\s+a\s+(?:line|message)).{0,80}[?!.]\s*$/iu
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

      const sentences = splitPreservingSentencePunctuation(response.output);

      if (sentences.length === 0) {
        return response;
      }

      const remaining = [...sentences];
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

      if (dropCount === 0) {
        return response;
      }

      if (remaining.length === 0) {
        return {
          ...response,
          output: response.output.trimEnd(),
          raw: withResponseFilterRaw(response, "english-casual-lure-strip-response-filter")
        };
      }

      const output = remaining.join(" ").trimEnd();

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "english-casual-lure-strip-response-filter")
      };
    },
    id: "english-casual-lure-strip-response-filter"
  };
}
