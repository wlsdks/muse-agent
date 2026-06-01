/**
 * Playbook strategy-merge orchestration with a SkillOpt held-out gate
 * (propose-and-test, arXiv 2605.23904): for each near-duplicate cluster, the
 * merger PROPOSES one strategy; it commits only if the held-out coverage gate
 * confirms the merged strategy still semantically covers every original, else
 * it is rejected and the originals are left intact. Pure orchestration — every
 * side-effecting seam (merge / validate / record / remove / log) is injected,
 * so the reject-rollback path is unit-testable without a model or store. Mirrors
 * `AuthoredSkillStore.consolidate`'s injectable design for the curator skill-merge.
 */

export interface PlaybookConsolidateItem {
  readonly id: string;
  readonly text: string;
  readonly tag?: string;
}

export interface ConsolidatePlaybookDeps {
  /** Merge a cluster's texts into one strategy, or undefined when genuinely distinct. */
  readonly merge: (
    texts: readonly string[],
    feedback?: { readonly avoidDropping: readonly string[] }
  ) => Promise<string | undefined>;
  /** Held-out gate: does `merged` still cover every `original`? `lost` steers a retry. */
  readonly validate: (
    originals: readonly string[],
    merged: string
  ) => Promise<{ readonly accept: boolean; readonly reason: string; readonly lost?: readonly string[] }>;
  /** When false, preview only — never record/remove. */
  readonly apply: boolean;
  readonly record: (mergedText: string, tag: string | undefined) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly log: (line: string) => void;
}

export interface ConsolidatePlaybookResult {
  /** Clusters that merged (or would, in preview). */
  readonly merged: number;
  /** Clusters the held-out gate rejected (a coherent merge that lost coverage). */
  readonly rejected: number;
}

export async function consolidatePlaybook(
  clusters: readonly (readonly PlaybookConsolidateItem[])[],
  deps: ConsolidatePlaybookDeps
): Promise<ConsolidatePlaybookResult> {
  let merged = 0;
  let rejected = 0;
  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    const texts = cluster.map((e) => e.text);
    let mergedText = await deps.merge(texts);
    if (!mergedText) continue; // genuinely distinct — leave them
    let verdict = await deps.validate(texts, mergedText);
    if (!verdict.accept && verdict.lost && verdict.lost.length > 0) {
      // SkillOpt rejected-edit loop: re-propose once, steered away from what it dropped.
      const retry = await deps.merge(texts, { avoidDropping: verdict.lost });
      if (retry) {
        const v2 = await deps.validate(texts, retry);
        if (v2.accept) {
          mergedText = retry;
          verdict = v2;
        }
      }
    }
    if (!verdict.accept) {
      rejected += 1;
      deps.log(`  rejected (held-out gate) — ${verdict.reason}`);
      continue; // roll back: originals stay, nothing recorded/removed
    }
    merged += 1;
    if (deps.apply) {
      await deps.record(mergedText, cluster[0]!.tag);
      for (const e of cluster) await deps.remove(e.id);
    }
    deps.log(`  ${deps.apply ? "merged" : "would merge"} ${cluster.length.toString()} → "${mergedText}"`);
  }
  return { merged, rejected };
}
