import type { ReindexSummary } from "@muse/recall";

export const DEFAULT_AUTO_REINDEX_MAX_EMBEDDINGS = 1;
export const DEFAULT_AUTO_REINDEX_EMBED_TIMEOUT_MS = 5_000;

function strictBoundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^(0|[1-9]\d*)$/u.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function explicitStrictBoundedInteger(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined || !/^(0|[1-9]\d*)$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

export interface AutoReindexBudget {
  readonly maxEmbeddingAttempts: number;
  readonly embedTimeoutMs: number;
}

export function resolveAutoReindexBudget(env: Record<string, string | undefined>): AutoReindexBudget {
  return {
    embedTimeoutMs: strictBoundedInteger(env.MUSE_AUTO_REINDEX_EMBED_TIMEOUT_MS, DEFAULT_AUTO_REINDEX_EMBED_TIMEOUT_MS, 250, 30_000),
    maxEmbeddingAttempts: strictBoundedInteger(env.MUSE_AUTO_REINDEX_MAX_EMBEDDINGS, DEFAULT_AUTO_REINDEX_MAX_EMBEDDINGS, 1, 64)
  };
}

/** Narrow resident-daemon allowlist: persist only valid explicit owner overrides. */
export function autoReindexBudgetEnvironment(env: Record<string, string | undefined>): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  const attempts = explicitStrictBoundedInteger(env.MUSE_AUTO_REINDEX_MAX_EMBEDDINGS, 1, 64);
  const timeout = explicitStrictBoundedInteger(env.MUSE_AUTO_REINDEX_EMBED_TIMEOUT_MS, 250, 30_000);
  if (attempts !== undefined) output.MUSE_AUTO_REINDEX_MAX_EMBEDDINGS = attempts.toString();
  if (timeout !== undefined) output.MUSE_AUTO_REINDEX_EMBED_TIMEOUT_MS = timeout.toString();
  return output;
}

export function autoReindexNotice(summary: ReindexSummary): string | undefined {
  if (summary.status === "pending" && summary.pendingReason === "checkpoint-too-large") {
    return "note is too large for bounded auto-index; run `muse notes reindex` to finish safely";
  }
  if (summary.status === "pending") {
    return `notes index update pending: ${summary.pendingFiles.toString()} file(s); next automatic pass will resume`;
  }
  if (summary.status === "busy") {
    return "notes index update already in progress; using last complete index";
  }
  return undefined;
}
