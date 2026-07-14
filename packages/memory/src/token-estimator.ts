/**
 * Approximate token estimator — pure heuristic that buckets each
 * code-point into Latin / CJK / emoji / other and converts to
 * tokens by bucket-specific ratios that roughly match the public
 * tokenizers' behaviour without pulling tiktoken / sentencepiece
 * into the runtime.
 *
 * Cache layer: per-text LRU keyed by the raw text (or its sha256
 * hex when text exceeds `cacheKeyMaxChars`, to bound key memory).
 * TTL bounded by `ttlMs`; cache size bounded by `maxEntries`.
 *
 * Extracted from `memory-token-trim.ts` so the file's main
 * concern — multi-pass conversation trimming — stays focused.
 * The `@muse/memory` barrel re-exports both functions, so external
 * callers see no API change.
 */

import { createHash } from "node:crypto";

import {
  DEFAULT_CACHE_KEY_MAX_CHARS,
  DEFAULT_TOKEN_CACHE_MAX_ENTRIES,
  DEFAULT_TOKEN_CACHE_TTL_MS,
  type TokenEstimator,
  type TokenEstimatorOptions
} from "./index.js";

interface CacheEntry {
  readonly expiresAt: number;
  readonly tokens: number;
}

export function createApproximateTokenEstimator(options: TokenEstimatorOptions = {}): TokenEstimator {
  const cacheKeyMaxChars = options.cacheKeyMaxChars ?? DEFAULT_CACHE_KEY_MAX_CHARS;
  const maxEntries = options.maxEntries ?? DEFAULT_TOKEN_CACHE_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? DEFAULT_TOKEN_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  return {
    estimate(text: string): number {
      if (text.length === 0) {
        return 0;
      }

      const key = text.length <= cacheKeyMaxChars ? text : sha256Hex(text);
      const now = Date.now();
      const cached = cache.get(key);

      if (cached && cached.expiresAt > now) {
        return cached.tokens;
      }

      const tokens = computeApproximateTokens(text);
      cache.set(key, { expiresAt: now + ttlMs, tokens });
      trimOldestCacheEntries(cache, maxEntries);
      return tokens;
    }
  };
}

export function computeApproximateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let latinChars = 0;
  let cjkChars = 0;
  let emojiChars = 0;
  let otherChars = 0;

  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;

    if (isEmojiCodePoint(codePoint)) {
      emojiChars++;
    } else if (isCjkCodePoint(codePoint)) {
      cjkChars++;
    } else if (codePoint <= 0x7f) {
      latinChars++;
    } else {
      otherChars++;
    }
  }

  const latinTokens = Math.floor(latinChars / 4);
  const cjkTokens = Math.floor((cjkChars * 2 + 1) / 3);
  const emojiTokens = emojiChars;
  const otherTokens = Math.floor(otherChars / 3);

  return Math.max(1, latinTokens + cjkTokens + emojiTokens + otherTokens);
}

function trimOldestCacheEntries(cache: Map<string, CacheEntry>, maxEntries: number): void {
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      return;
    }

    cache.delete(oldest.value);
  }
}

function isEmojiCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  );
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0x3040 && codePoint <= 0x309f) ||
    (codePoint >= 0x30a0 && codePoint <= 0x30ff)
  );
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
