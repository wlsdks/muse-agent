/**
 * Env-driven RAG query-transformer wiring.
 *
 * HyDE (Hypothetical Document Embeddings) and Decomposition transformers
 * already ship as library exports in @muse/rag, but they had no production
 * caller — operators who wanted them had to compose by hand. This module
 * provides:
 *
 *   - `composeQueryTransformers` — concatenates the outputs of multiple
 *     transformers (with deduplication) so HyDE + Decomposition can stack.
 *   - `createDefaultRagQueryTransformer` — env-gated builder that returns the
 *     correct composition based on `MUSE_RAG_HYDE_ENABLED`,
 *     `MUSE_RAG_DECOMPOSE_ENABLED`, and the presence of a model provider.
 *
 * Returns `undefined` when no transformer is wired so the consuming pipeline
 * can detect "use the raw query as-is".
 */

import type { ModelProvider } from "@muse/model";
import {
  DefaultRagPipeline,
  InMemoryRagCorpus,
  createLlmDecomposingQueryTransformer,
  createLlmHypotheticalDocumentTransformer,
  type DocumentRetriever,
  type QueryTransformer,
  type RagDocumentStore,
  type RagPipeline,
  type RetrievedDocument
} from "@muse/rag";

type RagFilters = Record<string, unknown>;

export interface RagQueryTransformerEnv {
  readonly MUSE_RAG_HYDE_ENABLED?: string;
  readonly MUSE_RAG_DECOMPOSE_ENABLED?: string;
  readonly MUSE_RAG_DECOMPOSE_MAX_QUERIES?: string;
}

export interface CreateDefaultRagQueryTransformerArgs {
  readonly env: RagQueryTransformerEnv;
  readonly modelProvider?: ModelProvider;
  readonly defaultModel?: string;
}

/**
 * Returns a single transformer that concatenates the outputs of every input
 * transformer (preserving order, deduplicating identical strings). When the
 * input list is empty returns `undefined` so callers can short-circuit.
 */
export function composeQueryTransformers(transformers: readonly QueryTransformer[]): QueryTransformer | undefined {
  if (transformers.length === 0) {
    return undefined;
  }
  if (transformers.length === 1) {
    return transformers[0];
  }
  return {
    async transform(query: string): Promise<readonly string[]> {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const transformer of transformers) {
        const queries = await transformer.transform(query);
        for (const value of queries) {
          if (!seen.has(value)) {
            seen.add(value);
            out.push(value);
          }
        }
      }
      return out;
    }
  };
}

export function createDefaultRagQueryTransformer(args: CreateDefaultRagQueryTransformerArgs): QueryTransformer | undefined {
  const hydeEnabled = parseBooleanFlag(args.env.MUSE_RAG_HYDE_ENABLED);
  const decomposeEnabled = parseBooleanFlag(args.env.MUSE_RAG_DECOMPOSE_ENABLED);

  if ((!hydeEnabled && !decomposeEnabled) || !args.modelProvider || !args.defaultModel) {
    return undefined;
  }

  const stages: QueryTransformer[] = [];
  if (hydeEnabled) {
    stages.push(
      createLlmHypotheticalDocumentTransformer({
        includeOriginal: true,
        model: args.defaultModel,
        provider: args.modelProvider
      })
    );
  }
  if (decomposeEnabled) {
    stages.push(
      createLlmDecomposingQueryTransformer({
        includeOriginal: true,
        maxQueries: parseMaxQueries(args.env.MUSE_RAG_DECOMPOSE_MAX_QUERIES, 5),
        model: args.defaultModel,
        provider: args.modelProvider
      })
    );
  }

  return composeQueryTransformers(stages);
}

function parseBooleanFlag(value: string | undefined, fallback = false): boolean {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return fallback;
}

function parseMaxQueries(value: string | undefined, fallback: number): number {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

/**
 * Wraps a `RagDocumentStore` as a `DocumentRetriever` by re-indexing the
 * store's documents into an `InMemoryRagCorpus` on every retrieve call. The
 * cache invalidates when the document count changes; for production-scale
 * usage operators should prefer a dedicated vector store, but this default
 * makes the runtime's RAG path actually populate against any of Muse's
 * RagDocumentStore impls (in-memory or Kysely-backed) out of the box.
 */
export function createDocumentStoreRetriever(documentStore: RagDocumentStore): DocumentRetriever {
  let cachedCount = -1;
  let cachedCorpus: InMemoryRagCorpus | undefined;
  return {
    async retrieve(queries: readonly string[], topK: number, filters?: RagFilters): Promise<readonly RetrievedDocument[]> {
      const documents = await documentStore.list({ limit: 1000 });
      if (documents.length !== cachedCount || !cachedCorpus) {
        const corpus = new InMemoryRagCorpus();
        for (const stored of documents) {
          corpus.add({
            content: stored.content,
            id: stored.id,
            metadata: stored.metadata ?? {},
            ...(stored.source ? { source: stored.source } : {})
          });
        }
        cachedCorpus = corpus;
        cachedCount = documents.length;
      }
      return cachedCorpus.retrieve(queries, topK, (filters ?? {}) as never);
    }
  };
}

export interface CreateDefaultRagPipelineArgs {
  readonly env: RagPipelineEnv;
  readonly modelProvider?: ModelProvider;
  readonly defaultModel?: string;
  readonly documentStore: RagDocumentStore;
}

export interface RagPipelineEnv extends RagQueryTransformerEnv {
  readonly MUSE_RAG_PIPELINE_ENABLED?: string;
  readonly MUSE_RAG_MAX_CONTEXT_TOKENS?: string;
}

/**
 * Builds a default `RagPipeline` from autoconfigure's stored documents:
 *
 *   - retriever: BM25 over the documents in `RagDocumentStore`
 *   - queryTransformer: HyDE/Decomposition chain (when env-enabled +
 *     model provider available)
 *   - maxContextTokens: tunable via `MUSE_RAG_MAX_CONTEXT_TOKENS`
 *
 * Personal-pivot default: ON. Set `MUSE_RAG_PIPELINE_ENABLED=false` to
 * disable. With the flag on but no documents stored, the pipeline returns
 * an empty context — non-blocking but explicit.
 */
export function createDefaultRagPipeline(args: CreateDefaultRagPipelineArgs): RagPipeline | undefined {
  if (!parseBooleanFlag(args.env.MUSE_RAG_PIPELINE_ENABLED, true)) {
    return undefined;
  }
  const queryTransformer = createDefaultRagQueryTransformer({
    defaultModel: args.defaultModel,
    env: args.env,
    modelProvider: args.modelProvider
  });
  const maxContextTokens = parseMaxQueries(args.env.MUSE_RAG_MAX_CONTEXT_TOKENS, 4_000);
  return new DefaultRagPipeline({
    maxContextTokens,
    ...(queryTransformer ? { queryTransformer } : {}),
    retriever: createDocumentStoreRetriever(args.documentStore)
  });
}
