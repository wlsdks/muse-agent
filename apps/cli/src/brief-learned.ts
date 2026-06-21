import { summarizeRecentlyLearned, type RecentlyLearnedItem } from "@muse/memory";
import { escapeSystemPromptMarkers, neutralizeInjectionSpans } from "@muse/recall";

/**
 * The morning-brief "what I've learned about you lately" beat — the FELT sibling
 * of the evening recap's recently-learned section and `muse status`'s line. ONE
 * compact, source-cited line from the deterministic projection
 * (`summarizeRecentlyLearned`: forgotten facts excluded, the prior value + date
 * embedded); undefined when nothing is recent, so the brief stays silent. Code
 * picks what to show, never the model. The cited text is injection-neutralized —
 * a learned value is user data, never an instruction promoted into the brief.
 */
export function formatBriefLearnedLine(items: readonly RecentlyLearnedItem[]): string | undefined {
  const summary = summarizeRecentlyLearned(items);
  if (summary === undefined) {
    return undefined;
  }
  return `\n📝 Lately about you — ${escapeSystemPromptMarkers(neutralizeInjectionSpans(summary))}\n`;
}
