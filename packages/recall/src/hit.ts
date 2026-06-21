export interface RecallHit {
  readonly source: "notes" | "episodes" | "memory";
  readonly ref: string;
  readonly score: number;
  readonly snippet: string;
  /**
   * `false` when this hit is an episode whose session rested on UNTRUSTED sources
   * (PersistedEpisode.trusted === false). Propagated to the chat grounding match so
   * an answer resting solely on a poisoned episode trips the untrusted-only
   * source-check cue instead of laundering it as trusted "your own history"
   * (MemoryGraft arXiv:2512.16962). Absent ⇒ trusted.
   */
  readonly trusted?: boolean;
}

/**
 * Fold the answer's already-ranked grounding (top note chunks + past-session
 * episodes) into a "💡 Related in your brain" footer set — provenance the user
 * can scan and trust, consistent with `muse today --connect`. Pure: reuses the
 * already-ranked hits (no extra search), keeps only those at/above the relevance
 * floor, ranks across both sources, and caps the list. Same RecallHit shape +
 * formatter as today, so the surfaces stay consistent.
 */
export function buildAskConnections(params: {
  readonly notes: ReadonlyArray<{ readonly file: string; readonly score: number; readonly text: string }>;
  readonly episodes: ReadonlyArray<{ readonly id: string; readonly score: number; readonly summary: string }>;
  readonly minScore?: number;
  readonly limit?: number;
}): RecallHit[] {
  const floor = params.minScore ?? 0.5;
  const limit = Math.max(1, params.limit ?? 4);
  const hits: RecallHit[] = [
    ...params.notes.map((n) => ({ ref: n.file, score: n.score, snippet: n.text, source: "notes" as const })),
    ...params.episodes.map((e) => ({ ref: e.id, score: e.score, snippet: e.summary, source: "episodes" as const }))
  ];
  return hits
    .filter((h) => Number.isFinite(h.score) && h.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
