/**
 * Consolidate near-duplicate learned playbook strategies — the curator merge
 * for the ReasoningBank `[Learned Strategies]` (sibling of the skill-umbrella
 * merge). One local-Qwen call folds a cluster of redundant strategies into ONE
 * general strategy, or returns undefined (NONE) when they are genuinely
 * distinct — so distinct strategies are never collapsed. The caller records
 * the merged strategy and removes the originals.
 *
 * Pattern adapted from Hermes Agent's curator consolidation (MIT) —
 * reimplemented for Muse, no code copied. See THIRD_PARTY_NOTICES.md.
 */

import type { ModelMessage, ModelProvider, ModelRequest } from "@muse/model";
import { redactSecretsInText } from "@muse/shared";

import { lexicalTokens } from "./knowledge-recall.js";

/**
 * ACE-style deterministic delta merge (arXiv 2510.04618): iterative LLM
 * REWRITING of a strategy cluster erodes detail ("context collapse"), so try
 * non-LLM delta ops FIRST — collapse whitespace-variant duplicates, and when
 * one strategy token-covers another keep only the MORE SPECIFIC one. Anything
 * the deterministic ops cannot reduce stays for the caller (the LLM merge +
 * coverage gate, unchanged). Never invents words, so the anti-collapse
 * invariant holds by construction: the survivor covers every merged input.
 */
export function deltaMergePlaybookStrategies(texts: readonly string[]): string | undefined {
  if (texts.length < 2) return undefined;
  const normalize = (text: string): string => text.replace(/\s+/gu, " ").trim();
  const unique = [...new Set(texts.map(normalize))];
  if (unique.length === 1) return unique[0];

  const tokenSets = unique.map((text) => lexicalTokens(text));
  // Korean conjugation/particles make exact token equality too strict
  // (정리한다 vs 정리하고 share the stem, not the token) — treat a token as
  // covered when a counterpart shares at least half of the LONGER token as a
  // prefix (min 2 chars). Conservative enough inside a similarity cluster:
  // a text is only dropped when EVERY token is covered, and anything not
  // reduced falls through to the coverage-gated LLM merge unchanged.
  const sharesStem = (a: string, b: string): boolean => {
    const required = Math.max(2, Math.ceil(Math.max(a.length, b.length) / 2));
    if (a.length < required || b.length < required) return false;
    return a.slice(0, required) === b.slice(0, required);
  };
  const covers = (a: Set<string>, b: Set<string>): boolean => {
    for (const token of b) {
      if (a.has(token)) continue;
      let stemmed = false;
      for (const candidate of a) {
        if (sharesStem(candidate, token)) { stemmed = true; break; }
      }
      if (!stemmed) return false;
    }
    return true;
  };
  const survivors = unique.filter((_, i) =>
    // An empty token set (tokenizer dropped everything) is vacuously covered
    // by anything — never let it be subsumed, and never let it subsume.
    tokenSets[i]!.size === 0
    || !unique.some((_, j) =>
      i !== j
      && tokenSets[j]!.size > 0
      && covers(tokenSets[j]!, tokenSets[i]!)
      && (tokenSets[j]!.size > tokenSets[i]!.size || (tokenSets[j]!.size === tokenSets[i]!.size && j < i))
    )
  );
  if (survivors.length !== 1) return undefined;
  const survivor = survivors[0]!;
  // Anti-collapse invariant guard: fuzzy stem coverage is NON-transitive
  // (A⊇B and B⊇C does NOT imply A⊇C — `required` scales with each token-pair's
  // length), so a chain of drops can leave a lone survivor that misses some
  // input's tokens. Verify the survivor truly covers EVERY input; if not, defer
  // to the LLM merge + coverage gate rather than silently dropping a strategy.
  const survivorTokens = lexicalTokens(survivor);
  for (const tokens of tokenSets) {
    if (tokens.size > 0 && !covers(survivorTokens, tokens)) return undefined;
  }
  return survivor;
}

/**
 * Greedy similarity clustering: each unclustered item seeds a cluster that
 * pulls in every other unclustered item with `similarity(text) >= threshold`.
 * Pure. Shared shape with the authored-skill clusterer.
 */
export function clusterByTextSimilarity<T>(
  items: readonly T[],
  getText: (item: T) => string,
  similarity: (a: string, b: string) => number,
  threshold: number
): readonly (readonly T[])[] {
  const used = new Set<number>();
  const clusters: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (used.has(i)) continue;
    const cluster = [items[i]!];
    used.add(i);
    for (let j = i + 1; j < items.length; j += 1) {
      if (used.has(j)) continue;
      if (similarity(getText(items[i]!), getText(items[j]!)) >= threshold) {
        cluster.push(items[j]!);
        used.add(j);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

export interface MergePlaybookOptions {
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly model: string;
  readonly redact?: (text: string) => string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /**
   * Steering feedback from a prior REJECTED attempt (SkillOpt's rejected-edit
   * loop): the strategy texts the previous merge dropped. Appended to the prompt
   * so the re-proposal must keep covering them.
   */
  readonly feedback?: { readonly avoidDropping: readonly string[] };
}

const MERGE_SYSTEM_PROMPT =
  `These are learned working strategies for an assistant. If they say
essentially the SAME thing, merge them into ONE clear, general strategy — a
single imperative sentence covering all of them. If they are genuinely
DIFFERENT strategies, output exactly: NONE (never collapse distinct
strategies). Output the merged strategy as one line, no prefix, no quotes, no
markdown.`;

/** Merge a cluster (>= 2) of strategy texts into one, or undefined (NONE / <2 / error). */
export async function mergePlaybookStrategies(
  texts: readonly string[],
  options: MergePlaybookOptions
): Promise<string | undefined> {
  if (texts.length < 2) return undefined;
  // Deterministic delta ops first (ACE): a cluster that reduces without the
  // model costs zero inference and cannot lose detail to a rewrite.
  const delta = deltaMergePlaybookStrategies(texts);
  if (delta !== undefined) return delta;
  const redact = options.redact ?? redactSecretsInText;
  const input = texts.map((t, i) => `${(i + 1).toString()}. ${redact(t)}`).join("\n");
  const avoid = options.feedback?.avoidDropping ?? [];
  const steer = avoid.length > 0
    ? `\n\nYour previous merge DROPPED the meaning of: ${avoid.map((t) => redact(t)).join(" | ")}. The merged strategy MUST still cover them, or output NONE.`
    : "";
  const messages: readonly ModelMessage[] = [
    { content: MERGE_SYSTEM_PROMPT, role: "system" },
    { content: `${input}${steer}`, role: "user" }
  ];
  const request: ModelRequest = {
    maxOutputTokens: options.maxOutputTokens ?? 100,
    messages,
    model: options.model,
    temperature: options.temperature ?? 0.3
  };
  let output: string;
  try {
    output = (await options.modelProvider.generate(request)).output?.trim() ?? "";
  } catch {
    return undefined;
  }
  if (output.length === 0 || /^NONE\b/iu.test(output)) return undefined;
  // Strip an accidental "strategy:" prefix and surrounding quotes.
  return output.replace(/^strategy:\s*/iu, "").replace(/^["']|["']$/gu, "").trim() || undefined;
}
