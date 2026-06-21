import type { FactSupersession, UserMemory } from "./index.js";

/**
 * A single "Muse learned this about you" item, projected deterministically
 * from a recorded {@link FactSupersession} — never inferred by a model.
 * `source` cites the recorded event (the prior value + the date it changed),
 * so a surface can show provenance without fabricating.
 */
export interface RecentlyLearnedItem {
  readonly key: string;
  /** The value now held for `key`, or undefined if the fact was since forgotten. */
  readonly currentValue: string | undefined;
  readonly previousValue: string;
  readonly replacedAt: Date;
  /** `changed` is the conservative framing for a legacy entry with no recorded kind. */
  readonly kind: "refine" | "contradict" | "changed";
  /** Deterministic provenance citation, e.g. `updated from "Seoul" on 2026-06-21`. */
  readonly source: string;
}

const DEFAULT_LIMIT = 5;

function formatSource(entry: FactSupersession): string {
  return `updated from ${JSON.stringify(entry.previousValue)} on ${entry.replacedAt.toISOString().slice(0, 10)}`;
}

/**
 * Project the most recently learned/updated facts about the user, newest first,
 * straight from the append-only `factHistory`. Pure + deterministic: the code
 * (not the model) selects what to surface, and every field traces to a recorded
 * supersession — an un-recorded "learning" can't appear, so a surface built on
 * this stays fabrication-free.
 */
export function projectRecentlyLearned(
  memory: Pick<UserMemory, "facts" | "factHistory"> & { readonly preferences?: Readonly<Record<string, string>> },
  options?: {
    readonly limit?: number;
    /**
     * Lower bound (epoch ms) on `replacedAt`: only learnings updated at or after
     * this instant are projected. Use it so a glanceable surface says "recently"
     * truthfully — without it a months-old supersession still shows when changes
     * are rare. Omit for no time bound.
     */
    readonly sinceMs?: number;
  }
): readonly RecentlyLearnedItem[] {
  const history = memory.factHistory ?? [];
  const limit = Math.max(0, options?.limit ?? DEFAULT_LIMIT);
  if (history.length === 0 || limit === 0) {
    return [];
  }
  const ordered = history
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const byTime = b.entry.replacedAt.getTime() - a.entry.replacedAt.getTime();
      // Equal timestamps: the later-appended entry is the newer learning.
      return byTime !== 0 ? byTime : b.index - a.index;
    });
  const sinceMs = options?.sinceMs;
  const items: RecentlyLearnedItem[] = [];
  for (const { entry } of ordered) {
    if (items.length >= limit) {
      break;
    }
    if (sinceMs !== undefined && entry.replacedAt.getTime() < sinceMs) {
      continue;
    }
    items.push({
      key: entry.key,
      currentValue: entry.scope === "preference" ? memory.preferences?.[entry.key] : memory.facts[entry.key],
      previousValue: entry.previousValue,
      replacedAt: entry.replacedAt,
      kind: entry.kind ?? "changed",
      source: formatSource(entry)
    });
  }
  return items;
}

/**
 * Render recently-learned items as user-facing lines for a surface to print,
 * deterministically. Only items still held (`currentValue` defined) appear — a
 * fact the user has since forgotten is not "what Muse currently knows about you".
 * Each line embeds its provenance citation, so a surface can never show an
 * unsourced learning claim. The key's `snake_case` is humanised to spaced words.
 */
export function renderRecentlyLearnedLines(items: readonly RecentlyLearnedItem[]): readonly string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (item.currentValue === undefined) {
      continue;
    }
    const label = item.key.replace(/_/g, " ");
    lines.push(`${label}: ${item.currentValue} (${item.source})`);
  }
  return lines;
}

/**
 * A single compact line of recent learning for a space-constrained surface
 * (a status dashboard, a daily briefing): the most recent cited learning plus a
 * `(+N more)` count of the rest. Returns undefined when nothing is currently
 * surfaced, so a caller renders the line only when there is something to say.
 * Built on renderRecentlyLearnedLines, so it inherits the forgotten-fact filter
 * and the citation — the compact form still points at a real source.
 */
export function summarizeRecentlyLearned(items: readonly RecentlyLearnedItem[]): string | undefined {
  const lines = renderRecentlyLearnedLines(items);
  const head = lines[0];
  if (head === undefined) {
    return undefined;
  }
  const more = lines.length - 1;
  return more > 0 ? `${head} (+${more} more)` : head;
}
