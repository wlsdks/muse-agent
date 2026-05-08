/**
 * RAG query transformer + adaptive router + contextual compressor
 * cluster extracted from packages/rag/src/index.ts.
 *
 * Owns five `QueryTransformer` implementations (`PassthroughQueryTransformer`,
 * `ConversationAwareQueryTransformer`, `HypotheticalDocumentQueryTransformer`,
 * `DecomposingQueryTransformer`), the three LLM-backed factories
 * (`createLlmHypotheticalDocumentTransformer` (HyDE), `createLlmDecomposingQueryTransformer`,
 * `createLlmAdaptiveQueryRouter` (Adaptive-RAG)), the `ExtractiveContextCompressor`
 * + `createLlmContextualCompressor` (RECOMP-style) compressors, plus the
 * `QueryComplexity` / `QueryRouter` types and the parsers
 * (`parseQueryComplexity`, `parseDecompositionLines`).
 *
 * Re-exported from the rag barrel for backwards compatibility.
 */

import type { ModelMessage, ModelProvider, ModelRequest } from "@muse/model";
import type { JsonObject } from "@muse/shared";
import type {
  Awaitable,
  ConversationAwareQueryTransformerOptions,
  ConversationAwareQueryTurn,
  ContextCompressor,
  DecomposingQueryTransformerOptions,
  ExtractiveContextCompressorOptions,
  HypotheticalDocumentQueryTransformerOptions,
  QueryTransformer,
  RetrievedDocument
} from "./index.js";

export class PassthroughQueryTransformer implements QueryTransformer {
  transform(query: string): readonly string[] {
    return [query];
  }
}

export class ConversationAwareQueryTransformer implements QueryTransformer {
  private readonly history: readonly ConversationAwareQueryTurn[];
  private readonly includeOriginal: boolean;
  private readonly maxHistoryTurns: number;
  private readonly maxQueries: number;
  private readonly maxContextChars: number;

  constructor(options: ConversationAwareQueryTransformerOptions = {}) {
    this.history = options.history ?? [];
    this.includeOriginal = options.includeOriginal ?? true;
    this.maxHistoryTurns = Math.max(1, options.maxHistoryTurns ?? 3);
    this.maxQueries = Math.max(1, options.maxQueries ?? 3);
    this.maxContextChars = Math.max(80, options.maxContextChars ?? 800);
  }

  transform(query: string): readonly string[] {
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      return [];
    }

    const queries = this.includeOriginal ? [trimmed] : [];
    const recentContext = this.recentUserContext(trimmed);

    if (recentContext && shouldExpandWithConversationContext(trimmed)) {
      queries.push(`${recentContext} ${trimmed}`);
    }

    if (queries.length === 0) {
      queries.push(trimmed);
    }

    return uniqueStrings(queries).slice(0, this.maxQueries);
  }

  private recentUserContext(query: string): string | undefined {
    const turns = this.history
      .filter((turn) => turn.role === "user")
      .map((turn) => normalizeWhitespace(turn.content))
      .filter((content) => content.length > 0 && content !== query)
      .slice(-this.maxHistoryTurns);

    if (turns.length === 0) {
      return undefined;
    }

    return truncateText(turns.join(" "), this.maxContextChars);
  }
}

export class HypotheticalDocumentQueryTransformer implements QueryTransformer {
  private readonly includeOriginal: boolean;
  private readonly generate: (query: string) => Awaitable<string>;

  constructor(options: HypotheticalDocumentQueryTransformerOptions) {
    this.generate = options.generate;
    this.includeOriginal = options.includeOriginal ?? true;
  }

  async transform(query: string): Promise<readonly string[]> {
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      return [];
    }

    const hypothetical = (await this.generate(trimmed)).trim();
    const queries = this.includeOriginal ? [trimmed] : [];

    if (hypothetical.length > 0 && hypothetical !== trimmed) {
      queries.push(hypothetical);
    }

    return queries;
  }
}

export class DecomposingQueryTransformer implements QueryTransformer {
  private readonly includeOriginal: boolean;
  private readonly maxQueries: number;

  constructor(options: DecomposingQueryTransformerOptions = {}) {
    this.includeOriginal = options.includeOriginal ?? true;
    this.maxQueries = Math.max(1, options.maxQueries ?? 5);
  }

  transform(query: string): readonly string[] {
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      return [];
    }

    const parts = trimmed
      .split(/\s+(?:and|or|then|vs\.?|versus)\s+|[?;]\s*|(?:그리고|또는|다음으로|대비|비교)\s*/iu)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const queries = this.includeOriginal ? [trimmed] : [];

    for (const part of parts) {
      if (!queries.includes(part)) {
        queries.push(part);
      }
      if (queries.length >= this.maxQueries) {
        break;
      }
    }

    return queries;
  }
}

export const HYDE_DEFAULT_SYSTEM_PROMPT =
  "Write a short passage (2-3 sentences) that would directly answer the following question. " +
  "Write as if you are quoting from an authoritative document. " +
  "Do not include any preamble like 'Here is...' — just write the passage itself.";

export const DECOMPOSE_DEFAULT_SYSTEM_PROMPT =
  "Break down this complex question into 2-4 simpler sub-questions that can be independently searched. " +
  "If the question is already simple, return it as-is.\n\n" +
  "Respond with one sub-question per line, no numbering or bullets.";

export interface LlmHypotheticalDocumentTransformerOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly includeOriginal?: boolean;
  readonly metadata?: JsonObject;
  readonly logger?: (message: string, error?: unknown) => void;
}

export function createLlmHypotheticalDocumentTransformer(
  options: LlmHypotheticalDocumentTransformerOptions
): QueryTransformer {
  const includeOriginal = options.includeOriginal ?? true;
  return {
    transform: async (query: string): Promise<readonly string[]> => {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return [];
      }
      let hypothetical = "";
      try {
        const messages: ModelMessage[] = [
          { content: options.systemPrompt ?? HYDE_DEFAULT_SYSTEM_PROMPT, role: "system" },
          { content: trimmed, role: "user" }
        ];
        const request: ModelRequest = {
          messages,
          model: options.model,
          ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
          ...(options.metadata ? { metadata: options.metadata } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {})
        };
        const response = await options.provider.generate(request);
        hypothetical = (response.output ?? "").trim();
      } catch (error) {
        options.logger?.("HyDE transformer fell back to original query", error);
      }
      const queries = includeOriginal ? [trimmed] : [];
      if (hypothetical.length > 0 && hypothetical !== trimmed) {
        queries.push(hypothetical);
      }
      return queries.length > 0 ? queries : [trimmed];
    }
  };
}

export interface LlmDecomposingQueryTransformerOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly maxQueries?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly includeOriginal?: boolean;
  readonly metadata?: JsonObject;
  readonly logger?: (message: string, error?: unknown) => void;
}

export function createLlmDecomposingQueryTransformer(
  options: LlmDecomposingQueryTransformerOptions
): QueryTransformer {
  const includeOriginal = options.includeOriginal ?? true;
  const maxQueries = Math.max(1, options.maxQueries ?? 5);
  return {
    transform: async (query: string): Promise<readonly string[]> => {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return [];
      }
      let raw = "";
      try {
        const messages: ModelMessage[] = [
          { content: options.systemPrompt ?? DECOMPOSE_DEFAULT_SYSTEM_PROMPT, role: "system" },
          { content: trimmed, role: "user" }
        ];
        const request: ModelRequest = {
          messages,
          model: options.model,
          ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
          ...(options.metadata ? { metadata: options.metadata } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {})
        };
        const response = await options.provider.generate(request);
        raw = response.output ?? "";
      } catch (error) {
        options.logger?.("decomposition transformer fell back to original query", error);
      }
      const subQueries = parseDecompositionLines(raw);
      const queries: string[] = includeOriginal ? [trimmed] : [];
      for (const candidate of subQueries) {
        if (queries.length >= maxQueries) {
          break;
        }
        if (!queries.includes(candidate)) {
          queries.push(candidate);
        }
      }
      return queries.length > 0 ? queries : [trimmed];
    }
  };
}

export type QueryComplexity = "no_retrieval" | "simple" | "complex";

export interface QueryRouter {
  route(query: string): Awaitable<QueryComplexity>;
}

export const ADAPTIVE_QUERY_ROUTER_DEFAULT_SYSTEM_PROMPT =
  "You classify user queries to decide whether document retrieval is needed.\n\n" +
  "Categories:\n" +
  "- NO_RETRIEVAL: Only for greetings (hello, hi), chitchat (how are you), or simple arithmetic. " +
  "Never for questions about products, features, how-to, configuration, registration, setup, " +
  "troubleshooting, or any domain topic.\n" +
  "- SIMPLE: Single fact lookup, how-to questions, feature questions, configuration or setup questions.\n" +
  "- COMPLEX: Multi-hop reasoning, comparison across entities, trend analysis, or questions requiring " +
  "multiple documents.\n\n" +
  "When in doubt, choose SIMPLE over NO_RETRIEVAL.\n" +
  "Respond with exactly one word: NO_RETRIEVAL, SIMPLE, or COMPLEX.";

export interface LlmAdaptiveQueryRouterOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly metadata?: JsonObject;
  readonly logger?: (message: string, error?: unknown) => void;
}

export function createLlmAdaptiveQueryRouter(options: LlmAdaptiveQueryRouterOptions): QueryRouter {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 3_000);
  return {
    route: async (query: string): Promise<QueryComplexity> => {
      try {
        const generate = async (): Promise<QueryComplexity> => {
          const messages: ModelMessage[] = [
            { content: options.systemPrompt ?? ADAPTIVE_QUERY_ROUTER_DEFAULT_SYSTEM_PROMPT, role: "system" },
            { content: query, role: "user" }
          ];
          const request: ModelRequest = {
            messages,
            model: options.model,
            ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
            ...(options.metadata ? { metadata: options.metadata } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {})
          };
          const response = await options.provider.generate(request);
          return parseQueryComplexity(response.output ?? "");
        };
        if (timeoutMs > 0) {
          return await Promise.race([
            generate(),
            new Promise<QueryComplexity>((_, reject) => {
              setTimeout(() => reject(new Error("AdaptiveQueryRouter timeout")), timeoutMs).unref?.();
            })
          ]);
        }
        return await generate();
      } catch (error) {
        options.logger?.("AdaptiveQueryRouter fell back to SIMPLE", error);
        return "simple";
      }
    }
  };
}

/** Visible for testing — parses an LLM verdict into a `QueryComplexity` with safe SIMPLE fallback. */
export function parseQueryComplexity(raw: string): QueryComplexity {
  const upper = raw.trim().toUpperCase();
  if (upper.includes("COMPLEX")) {
    return "complex";
  }
  if (upper.includes("NO_RETRIEVAL")) {
    return "no_retrieval";
  }
  if (upper.includes("SIMPLE")) {
    return "simple";
  }
  return "simple";
}

export const LLM_CONTEXTUAL_COMPRESSOR_DEFAULT_SYSTEM_PROMPT =
  "You are a document compression assistant. " +
  "Extract only the information relevant to the user's query. " +
  "Remove all irrelevant content. " +
  "If nothing is relevant, respond with exactly \"IRRELEVANT\".";

const LLM_CONTEXTUAL_COMPRESSOR_IRRELEVANT_PATTERN = /^irrelevant[.!]?$/iu;

export interface LlmContextualCompressorOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly minContentLength?: number;
  readonly maxConcurrent?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly metadata?: JsonObject;
  readonly logger?: (message: string, error?: unknown) => void;
}

export function createLlmContextualCompressor(
  options: LlmContextualCompressorOptions
): ContextCompressor {
  const minContentLength = Math.max(0, options.minContentLength ?? 200);
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 5);
  const systemPrompt = options.systemPrompt ?? LLM_CONTEXTUAL_COMPRESSOR_DEFAULT_SYSTEM_PROMPT;

  async function compressOne(query: string, document: RetrievedDocument): Promise<RetrievedDocument | undefined> {
    if (document.content.length < minContentLength) {
      return document;
    }
    const userPrompt = `Query: ${query}\n\nDocument:\n${document.content}\n\nRelevant extract:`;
    let raw: string;
    try {
      const request: ModelRequest = {
        messages: [
          { content: systemPrompt, role: "system" },
          { content: userPrompt, role: "user" }
        ],
        model: options.model,
        ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {})
      };
      const response = await options.provider.generate(request);
      raw = response.output ?? "";
    } catch (error) {
      options.logger?.(`contextual compressor preserved document ${document.id} after provider error`, error);
      return document;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return document;
    }
    if (LLM_CONTEXTUAL_COMPRESSOR_IRRELEVANT_PATTERN.test(trimmed)) {
      return undefined;
    }
    return { ...document, content: trimmed };
  }

  return {
    compress: async (query: string, documents: readonly RetrievedDocument[]): Promise<readonly RetrievedDocument[]> => {
      if (documents.length === 0) {
        return [];
      }
      const results: (RetrievedDocument | undefined)[] = new Array(documents.length);
      let cursor = 0;
      async function worker(): Promise<void> {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= documents.length) {
            return;
          }
          const document = documents[index];
          if (!document) {
            continue;
          }
          results[index] = await compressOne(query, document);
        }
      }
      const lanes = Math.min(maxConcurrent, documents.length);
      await Promise.all(Array.from({ length: lanes }, () => worker()));
      return results.filter((document): document is RetrievedDocument => document !== undefined);
    }
  };
}

/** Visible for testing — splits an LLM response into trimmed, non-empty lines. */
export function parseDecompositionLines(raw: string): readonly string[] {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.replace(/^[-*0-9.)\s]+/u, "").trim())
    .filter((line) => line.length > 0);
}

export class ExtractiveContextCompressor implements ContextCompressor {
  private readonly maxSentencesPerDocument: number;
  private readonly minScore: number;

  constructor(options: ExtractiveContextCompressorOptions = {}) {
    this.maxSentencesPerDocument = Math.max(1, options.maxSentencesPerDocument ?? 3);
    this.minScore = Math.max(0, options.minScore ?? 0);
  }

  compress(query: string, documents: readonly RetrievedDocument[]): readonly RetrievedDocument[] {
    const queryTokens = new Set(tokenize(query));

    return documents.flatMap((document) => {
      const selected = splitSentences(document.content)
        .map((sentence) => ({
          score: overlapScore(queryTokens, new Set(tokenize(sentence))),
          sentence
        }))
        .filter((candidate) => candidate.score >= this.minScore)
        .sort((left, right) => right.score - left.score)
        .slice(0, this.maxSentencesPerDocument)
        .map((candidate) => candidate.sentence);

      if (selected.length === 0) {
        return [];
      }

      const content = selected.join(" ");
      return [{
        ...document,
        content,
        estimatedTokens: Math.max(1, Math.ceil(document.estimatedTokens * (content.length / Math.max(1, document.content.length)))),
        metadata: {
          ...document.metadata,
          compressed: true,
          originalEstimatedTokens: document.estimatedTokens
        }
      }];
    });
  }
}

const minTokenLength = 2;
const maxKoreanNgramLength = 4;

function tokenize(text: string): readonly string[] {
  const normalized = text.toLowerCase();
  const words = normalized.split(/[^a-z0-9가-힣]+/u).filter((word) => word.length >= minTokenLength);
  const extra: string[] = [];

  for (const word of words) {
    for (const run of word.matchAll(/[가-힣]{2,}/gu)) {
      const value = run[0];

      for (let start = 0; start < value.length; start += 1) {
        for (let length = minTokenLength; length <= Math.min(maxKoreanNgramLength, value.length - start); length += 1) {
          const token = value.slice(start, start + length);

          if (token !== word) {
            extra.push(token);
          }
        }
      }
    }
  }

  return [...words, ...extra];
}

function overlapScore(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let matches = 0;

  for (const token of left) {
    if (right.has(token)) {
      matches += 1;
    }
  }

  return matches / left.size;
}

function splitSentences(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function shouldExpandWithConversationContext(query: string): boolean {
  const normalized = query.toLowerCase();

  if (/\b(it|that|this|those|them|they|he|she|what about|how about|follow up|same|previous|above)\b/u.test(normalized)) {
    return true;
  }

  if (/(그것|그건|이건|저건|이전|위의|같은|그러면|그럼|어떻게|뭐가|어떤가)/u.test(query)) {
    return true;
  }

  return tokenize(query).length <= 6;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd();
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }

  return unique;
}
