export interface TopicDriftTopic {
  readonly id: string;
  readonly keywords: readonly string[];
}

export interface TopicDriftOptions {
  readonly allowedOffTopicKeywords?: readonly string[];
  readonly allowedTopics: readonly TopicDriftTopic[];
  readonly minScore?: number;
}

export type TopicDriftDecision =
  | {
      readonly allowed: true;
      readonly bestScore: number;
      readonly matchedKeywords: readonly string[];
      readonly matchedTopicId: string | null;
      readonly reason?: string;
    }
  | {
      readonly allowed: false;
      readonly bestScore: number;
      readonly matchedKeywords: readonly string[];
      readonly matchedTopicId: string | null;
      readonly reason: string;
    };

export function detectTopicDrift(text: string, options: TopicDriftOptions): TopicDriftDecision {
  const normalizedText = normalizeText(text);
  const topics = options.allowedTopics.filter((topic) => topic.id.trim().length > 0);

  if (topics.length === 0 || normalizedText.length === 0) {
    return {
      allowed: true,
      bestScore: 1,
      matchedKeywords: [],
      matchedTopicId: null
    };
  }

  if (matchesAnyKeyword(normalizedText, options.allowedOffTopicKeywords ?? [])) {
    return {
      allowed: true,
      bestScore: 1,
      matchedKeywords: [],
      matchedTopicId: null,
      reason: "Allowed by off-topic exception"
    };
  }

  const best = topics
    .map((topic) => scoreTopic(normalizedText, topic))
    .sort((left, right) => right.score - left.score || right.matchedKeywords.length - left.matchedKeywords.length)[0];
  const threshold = Math.max(0, options.minScore ?? 0.2);

  if (best && best.score >= threshold) {
    return {
      allowed: true,
      bestScore: best.score,
      matchedKeywords: best.matchedKeywords,
      matchedTopicId: best.topic.id
    };
  }

  return {
    allowed: false,
    bestScore: best?.score ?? 0,
    matchedKeywords: best?.matchedKeywords ?? [],
    matchedTopicId: best && best.score > 0 ? best.topic.id : null,
    reason: `Prompt drifted outside allowed topics: ${topics.map((topic) => topic.id).join(", ")}`
  };
}

function scoreTopic(normalizedText: string, topic: TopicDriftTopic): {
  readonly matchedKeywords: readonly string[];
  readonly score: number;
  readonly topic: TopicDriftTopic;
} {
  const keywords = normalizeKeywords(topic.keywords);
  const matchedKeywords = keywords.filter((keyword) => containsKeyword(normalizedText, keyword));

  return {
    matchedKeywords,
    score: keywords.length === 0 ? 0 : matchedKeywords.length / keywords.length,
    topic
  };
}

function matchesAnyKeyword(normalizedText: string, keywords: readonly string[]): boolean {
  return normalizeKeywords(keywords).some((keyword) => containsKeyword(normalizedText, keyword));
}

/**
 * ASCII/Latin keywords must match on word boundaries — a raw
 * substring lets a short keyword ("ai", "go", "db", "rag") fire
 * inside unrelated words ("email", "ago", "fragment") and silently
 * defeat the drift guard. CJK keywords keep substring matching:
 * Korean (the primary user language) agglutinates particles
 * without spaces ("우선순위" inside "우선순위를"), where a
 * word-boundary rule would wrongly miss the stem.
 */
function containsKeyword(haystack: string, keyword: string): boolean {
  if (keyword.length === 0) {
    return false;
  }
  if (hasCjkChar(keyword)) {
    return haystack.includes(keyword);
  }
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "u").test(haystack);
}

function hasCjkChar(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||  // CJK Unified Ideographs
      (cp >= 0xac00 && cp <= 0xd7af) ||  // Hangul Syllables
      (cp >= 0x3040 && cp <= 0x309f) ||  // Hiragana
      (cp >= 0x30a0 && cp <= 0x30ff)     // Katakana
    ) {
      return true;
    }
  }
  return false;
}

function normalizeKeywords(keywords: readonly string[]): readonly string[] {
  return [...new Set(keywords.map(normalizeText).filter(Boolean))];
}

function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
