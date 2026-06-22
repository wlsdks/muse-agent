/**
 * External-data lines for `muse today`: the current-weather line and recent
 * feed headlines. Split out of commands-today.ts; both read client-side and
 * fail-soft (a missing location / unreadable store just omits the section).
 */

import { OpenMeteoWeatherProvider, resolveWeatherLine, type WeatherProvider } from "@muse/domain-tools";
import { stripUntrustedTerminalChars } from "@muse/shared";

import { compareFeedEntriesNewestFirst, defaultFeedsFile, filterRecentFeedEntries, readFeedsStore } from "./feeds-store.js";

/**
 * Current-weather line for `muse today` — keyed on MUSE_WEATHER_LOCATION
 * (the user's home). Fetched by the CLI itself (Open-Meteo, no
 * key) so it shows in BOTH local and remote modes without a server
 * change. Fail-soft: no location configured, or a lookup failure, →
 * undefined (no weather line), never breaks the briefing.
 */
export async function resolveTodayWeatherLine(
  env: Record<string, string | undefined>,
  provider?: WeatherProvider
): Promise<string | undefined> {
  const location = env.MUSE_WEATHER_LOCATION?.trim();
  if (!location || location.length === 0) {
    return undefined;
  }
  return resolveWeatherLine(provider ?? new OpenMeteoWeatherProvider(), location);
}

export function formatWeatherLine(weather: string | undefined): string {
  if (!weather || weather.trim().length === 0) {
    return "";
  }
  return `\nWeather: ${weather.trim()}\n`;
}

const DEFAULT_TODAY_HEADLINES_CAP = 5;

/**
 * Recent feed headlines for the brief: entries published within the
 * lookahead window (mirrors `muse feeds today`), newest-first, capped.
 * Read client-side from the local feeds store — fail-soft (a missing /
 * unreadable store yields `undefined`, so the brief just omits the
 * section rather than failing). `cap` keeps the brief concise.
 */
export async function resolveTodayFeedHeadlines(
  env: Record<string, string | undefined>,
  lookaheadHours: number,
  cap: number = DEFAULT_TODAY_HEADLINES_CAP
): Promise<readonly { readonly feedId: string; readonly title: string; readonly link: string; readonly publishedAt: string }[] | undefined> {
  const hours = Number.isFinite(lookaheadHours) && lookaheadHours > 0 ? lookaheadHours : 24;
  const effectiveCap = Number.isFinite(cap) && cap > 0 ? Math.trunc(cap) : DEFAULT_TODAY_HEADLINES_CAP;
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  let store;
  try {
    store = await readFeedsStore(env.MUSE_FEEDS_FILE?.trim() || defaultFeedsFile());
  } catch {
    return undefined;
  }
  const recent = store.feeds
    .flatMap((feed) => filterRecentFeedEntries(feed.entries, cutoff).map((entry) => ({ entry, feedId: feed.id })))
    .sort((a, b) => compareFeedEntriesNewestFirst(a.entry, b.entry))
    .slice(0, effectiveCap)
    .map(({ entry, feedId }) => ({ feedId, link: entry.link, publishedAt: entry.publishedAt, title: entry.title }));
  return recent.length > 0 ? recent : undefined;
}

export function formatHeadlines(
  headlines: readonly { readonly feedId: string; readonly title: string; readonly publishedAt: string }[] | undefined
): string {
  if (!headlines || headlines.length === 0) {
    return "";
  }
  // Feed titles are third-party-controlled — strip ESC/C0/C1/DEL like
  // the inbox / feeds / search surfaces before printing to the terminal.
  const clean = (value: string): string => stripUntrustedTerminalChars(value).replace(/\s+/gu, " ").trim();
  const lines = headlines.map((h) => `  - [${clean(h.feedId)}] ${clean(h.title)}`);
  return `\nHeadlines (${headlines.length.toString()}):\n${lines.join("\n")}\n`;
}
