/**
 * RAG-Fusion compound-query splitter (arXiv:2402.03367, Rackauckas 2024).
 *
 * A single embedding for a compound question ("내 WireGuard MTU랑 집세 내는 날?")
 * lands between both topics in embedding space, so with a small topK one
 * answer-bearing chunk may rank out. Deterministic clause splitting avoids
 * the paper's LLM-generator topic-drift failure and adds zero extra LLM calls.
 *
 * Returns clauses ONLY when there are 2–3 of them AND each clause has ≥2
 * content tokens (reusing `lexicalTokens`). Otherwise returns [] (not
 * compound) so the caller falls back to the full-query path unchanged.
 *
 * Conservative by design: a false negative = status quo (full-query only);
 * a false positive costs at most one extra embed call.
 */

import { lexicalTokens } from "./knowledge-recall.js";

/**
 * Coordination markers that signal an AND-type compound question in Korean
 * and English. Ordered longest-first so a longer pattern shadows a shorter
 * prefix before the split regex is applied.
 *
 * KO: 이랑/랑 /하고/그리고/및 — conjunctive "and". 랑 requires trailing
 *     whitespace to avoid splitting mid-word (e.g. "MTU랑 집세" → two clauses
 *     but "랑래" is not a connector). 각각 ("each") is intentionally omitted —
 *     it is a semantic qualifier on the result, not a clause connector, and
 *     treating it as a boundary fragments the trailing clause.
 * EN: " and ", " also " — clause-level coordination (space-padded to avoid
 *     splitting inside compound words like "bandwidth").
 * Sentence boundary: "?" followed by whitespace inside a string = two distinct
 *     sub-questions ("내 MTU가 뭐야? 집세는?").
 */
const COORD_SPLIT_RE =
  /(?:이랑|랑\s|하고|그리고|및| and | also |\?\s+)/u;

const MAX_CLAUSES = 3;
const MIN_CONTENT_TOKENS = 2;

/**
 * Split a compound query into its retrievable sub-queries.
 *
 * Returns a readonly array of 2–3 clause strings when the input is compound
 * (each clause ≥2 content tokens). Returns [] when the query is simple,
 * greeting, anaphoric, or has too many / too few clauses.
 *
 * Pure, deterministic, never throws.
 */
export function splitCompoundQuery(query: string): readonly string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const parts = trimmed.split(COORD_SPLIT_RE)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length < 2 || parts.length > MAX_CLAUSES) return [];

  for (const part of parts) {
    if (lexicalTokens(part).size < MIN_CONTENT_TOKENS) return [];
  }

  return parts;
}
