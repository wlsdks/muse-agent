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
DIFFERENT strategies, output exactly: NONE. NEVER join different strategies
with "and" / a list — concatenating two distinct strategies into one sentence
is collapsing them, which is forbidden; output NONE instead. Output the merged
strategy as one line (in the SAME LANGUAGE as the inputs), no prefix, no quotes,
no markdown.`;

/** Merge a cluster (>= 2) of strategy texts into one, or undefined (NONE / <2 / error). */
export async function mergePlaybookStrategies(
  texts: readonly string[],
  options: MergePlaybookOptions
): Promise<string | undefined> {
  if (texts.length < 2) return undefined;
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
