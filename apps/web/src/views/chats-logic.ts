import type { Translate } from "../i18n/index.js";
import type { StringKey } from "../i18n/strings.js";

/** Maps a conversation's `origin` (any surface that appends to the shared
 * store — cli/web/telegram/matrix today) to its badge label key. An
 * unrecognized origin (a future surface, or free-form test data) falls back
 * to a generic label rather than rendering the raw string. */
export function originBadgeLabelKey(origin: string): StringKey {
  switch (origin) {
    case "cli":
      return "chats.origin.cli";
    case "web":
      return "chats.origin.web";
    case "telegram":
      return "chats.origin.telegram";
    case "matrix":
      return "chats.origin.matrix";
    default:
      return "chats.origin.other";
  }
}

/** "X ago" relative time for a conversation's `updatedAt`, mirroring
 * `Today.tsx`'s `timeUntil` but for the past. `now` is injectable so the
 * boundary minutes/hours/days math is deterministic in tests. */
export function relativeAgo(iso: string, t: Translate, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) {
    return "";
  }
  if (ms < 60_000) {
    return t("rel.now");
  }
  const absMin = Math.round(ms / 60_000);
  if (absMin < 60) {
    return t("rel.agoMinutes", { n: absMin });
  }
  const hr = Math.round(absMin / 60);
  if (hr < 24) {
    return t("rel.agoHours", { n: hr });
  }
  return t("rel.agoDays", { n: Math.round(hr / 24) });
}

/** Case-insensitive title filter for the conversation list. Deterministic,
 * client-side only — the list is already capped server-side. An empty or
 * whitespace query returns the list unchanged. */
export function filterConversations<T extends { readonly title: string }>(
  conversations: readonly T[],
  query: string
): readonly T[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return conversations;
  }
  return conversations.filter((c) => c.title.toLowerCase().includes(q));
}
