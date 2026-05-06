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
  const matchedKeywords = keywords.filter((keyword) => normalizedText.includes(keyword));

  return {
    matchedKeywords,
    score: keywords.length === 0 ? 0 : matchedKeywords.length / keywords.length,
    topic
  };
}

function matchesAnyKeyword(normalizedText: string, keywords: readonly string[]): boolean {
  return normalizeKeywords(keywords).some((keyword) => normalizedText.includes(keyword));
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
