/**
 * Bounded deterministic identifier for a recall query, used by the
 * query-diversity promotion gate (`selectPromotableMemories`'s
 * `minUniqueQueries`) so ONE identical query repeated many times can't inflate
 * a memory's hit count into promotion the way genuinely distinct questions
 * would. Not cryptographic — a short djb2 hash is enough to distinguish real
 * queries while keeping the recall-hits sidecar small.
 */

/** Lowercase + collapse internal whitespace + trim, so text-shape differences don't count as a different query. */
export function normalizeQueryForHash(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/gu, " ");
}

const HASH_HEX_RADIX = 16;
const HASH_HEX_LENGTH = 8;

/** Deterministic 8-hex-char djb2 hash of the normalized query text. */
export function hashQuery(query: string): string {
  const normalized = normalizeQueryForHash(query);
  let hash = 5381;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(HASH_HEX_RADIX).padStart(HASH_HEX_LENGTH, "0");
}
