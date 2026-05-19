import type { ModelResponse } from "@muse/model";

import { withResponseFilterRaw } from "./internals.js";
import type { ResponseFilterStage } from "./types.js";

/**
 * Apply the anchored strip patterns repeatedly until the prefix
 * stops shrinking. Reasoning-off Qwen-class models stack
 * acknowledgements ("Sure! Of course! …", "Hi there! Got it! …")
 * and a single anchored `.replace` only removes the first one. The
 * pass cap bounds worst-case work — a model never stacks anywhere
 * near this many distinct lead-ins.
 */
function stripLeadingNoise(input: string, patterns: readonly RegExp[]): string {
  let current = input;
  for (let pass = 0; pass < 5; pass++) {
    let next = current;
    for (const pattern of patterns) {
      next = next.replace(pattern, "");
    }
    next = next.trimStart();
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

/**
 * Greeting-strip response filters.
 *
 * Two factories — Korean and English — extracted from
 * `response-filters.ts` so the salutation regex tables stay
 * together with the loops that use them. The filters target
 * disjoint patterns and can run in the same chain.
 */

export function createGreetingStripResponseFilter(): ResponseFilterStage {
  const leadingGreetingPattern =
    /^(안녕하세요|안녕|반가워요|반갑습니다|반갑네요|하이)(?:[,，]?\s*[^\n!?.]{0,25}[님씨])?[!?.]\s*/u;
  const followupGreetingPattern =
    /^(반갑습니다|반가워요|반갑네요|만나서\s*반가워요|만나서\s*반갑습니다|만나서\s*정말\s*반가워요|만나서\s*정말\s*기쁩니다|좋은\s*아침이에요|좋은\s*저녁이에요)[!?.]\s*/u;
  // Korean counterpart of the English leading-filler strip:
  // trailing `\s+` requires content after the punctuation, so a
  // one-word reply ("네.", "물론입니다.") is never nuked and
  // "물론 그것도 가능합니다" (real content) is never touched.
  const leadingFillerPattern =
    /^\s*(?:물론(?:이죠|입니다|이에요|이지요|이야)?|알겠습니다|알겠어요|네|그럼요|당연(?:하죠|합니다|하지요|해요|히)?)\s*[!?.]\s+/u;

  return {
    apply: (response: ModelResponse) => {
      if (response.output.trim().length === 0) {
        return response;
      }

      const output = stripLeadingNoise(response.output, [
        leadingFillerPattern,
        leadingGreetingPattern,
        followupGreetingPattern
      ]);

      // A reply that is ONLY a greeting/filler must not be stripped
      // to nothing — the filter removes a preamble, not the whole
      // turn. An unstripped greeting beats total silence (the
      // inbound path treats an empty reply as "handled, send
      // nothing").
      if (output.trim().length === 0) {
        return response;
      }

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
 * "Hello!", "Good morning!", "Greetings,", plus a leading compliance
 * filler ("Sure!", "Certainly.", "Of course!", "Got it!") that Qwen-class
 * models emit constantly with reasoning off and that undercuts the terse
 * JARVIS persona. Both filters can run in the same chain — they target
 * disjoint patterns, so neither cancels the other.
 */
export function createEnglishGreetingStripResponseFilter(): ResponseFilterStage {
  const leadingGreetingPattern =
    /^\s*(?:Hi|Hello|Hey|Howdy|Greetings|Hiya)(?:\s+(?:there|all|everyone|team|folks|y'all))?(?:,\s*\w{1,20})?[!?.]\s+/iu;
  const goodTimeOfDayPattern = /^\s*Good\s+(?:morning|afternoon|evening|day|night)(?:\s+\w{1,20})?[!?.]\s+/iu;
  const niceToMeetPattern = /^\s*(?:Nice|Pleased|Good|Glad)\s+to\s+(?:meet|see)\s+you[!?.]\s+/iu;
  // Only strip when the filler is immediately closed by punctuation +
  // whitespace + more content, so "Surely…", "Of course not.",
  // "Absolutely fascinating…" (real content) are never touched.
  const leadingFillerPattern =
    /^\s*(?:Sure(?:\s+thing)?|Certainly|Of\s+course|Absolutely|Got\s+it|No\s+problem|Sounds\s+good|Understood|Alright(?:y)?)\s*[!?.]\s+/iu;

  return {
    apply: (response: ModelResponse) => {
      if (response.output.trim().length === 0) {
        return response;
      }

      const output = stripLeadingNoise(response.output, [
        leadingFillerPattern,
        leadingGreetingPattern,
        goodTimeOfDayPattern,
        niceToMeetPattern
      ]);

      // See the Korean filter: never strip a greeting-only reply
      // down to an empty turn (silence is worse than the greeting).
      if (output.trim().length === 0) {
        return response;
      }

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
