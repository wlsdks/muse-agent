import { contentTokens } from "./provenance-tokens.js";

const DEFAULT_MAX_SPANS = 64;
const DEFAULT_MAX_CHARS_PER_SPAN = 8000;

export interface UntrustedSpan {
  readonly source: string;
  readonly text: string;
}

export interface TaintLedger {
  recordUntrusted(source: string, text: string): void;
  untrustedSpans(): readonly UntrustedSpan[];
  untrustedTokens(): ReadonlySet<string>;
}

/**
 * Per-run ledger of untrusted (tool-output-derived) text spans — the
 * provenance-tracking half of a FIDES-style taint gate (arXiv 2505.23643).
 * Bounded memory: oldest spans are evicted once maxSpans is exceeded, and
 * each span's text is truncated to maxCharsPerSpan so one huge tool result
 * can't blow up per-run state.
 */
export function createTaintLedger(options?: { maxSpans?: number; maxCharsPerSpan?: number }): TaintLedger {
  const maxSpans = options?.maxSpans ?? DEFAULT_MAX_SPANS;
  const maxCharsPerSpan = options?.maxCharsPerSpan ?? DEFAULT_MAX_CHARS_PER_SPAN;
  const spans: UntrustedSpan[] = [];
  let tokenCache: Set<string> | null = null;

  return {
    recordUntrusted(source: string, text: string): void {
      if (text.trim().length === 0) {
        return;
      }
      const truncated = text.length > maxCharsPerSpan ? text.slice(0, maxCharsPerSpan) : text;
      spans.push({ source, text: truncated });
      while (spans.length > maxSpans) {
        spans.shift();
      }
      tokenCache = null;
    },
    untrustedSpans(): readonly UntrustedSpan[] {
      return spans.slice();
    },
    untrustedTokens(): ReadonlySet<string> {
      if (tokenCache === null) {
        const union = new Set<string>();
        for (const span of spans) {
          for (const token of contentTokens(span.text)) {
            union.add(token);
          }
        }
        tokenCache = union;
      }
      return tokenCache;
    }
  };
}
