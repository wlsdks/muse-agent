/**
 * Shared Chrome-history → local-archive sync core, used by BOTH the on-demand
 * `muse browsing sync` command and the daemon's opt-in `browsingAutoSyncTick`,
 * so the manual and always-on surfaces ingest IDENTICALLY (locate → read since
 * cursor → merge → write store → advance cursor).
 *
 * The daemon path is reached ONLY behind an explicit opt-in
 * (`MUSE_BROWSING_AUTO_SYNC`); this module never decides that — it is pure
 * mechanism. Read-only against the Chrome file (a temp copy is opened; the
 * original is never touched, per chrome-history.ts) and written locally.
 */

import type { BrowsingVisit } from "./browsing-store.js";
import {
  defaultBrowsingFile,
  mergeBrowsingVisits,
  readBrowsingStore,
  writeBrowsingStore
} from "./browsing-store.js";
import { readChromeHistoryVisits } from "./chrome-history.js";

/** Max visits read from Chrome per sync — bounds a single pass over a large History file. */
export const BROWSING_SYNC_LIMIT = 2000;

export interface SyncBrowsingHistoryOptions {
  /** Located Chrome `History` file (callers locate first — see `locateChromeHistoryFile`). */
  readonly historyFile: string;
  /** Destination archive; defaults to `~/.muse/browsing.json`. */
  readonly storeFile?: string;
  /** Max rows to read this pass. Default `BROWSING_SYNC_LIMIT`. */
  readonly limit?: number;
}

export interface SyncBrowsingHistoryResult {
  /** New visits ingested this pass (rows strictly newer than the stored cursor). */
  readonly synced: number;
  /** Total visits in the archive after the merge. */
  readonly total: number;
}

/** Exact WebKit-epoch µs of a visit, parsed from the `<micros>-<hash>` id — 0 when unparseable. */
export function cursorFromBrowsingVisit(visit: BrowsingVisit): number {
  const prefix = visit.id.split("-")[0];
  const micros = Number(prefix);
  return Number.isFinite(micros) ? micros : 0;
}

/**
 * Read new Chrome visits since the archive's cursor, merge them in, persist, and
 * advance the cursor. Incremental (only rows newer than the cursor) and
 * idempotent (visit ids dedup on merge), so a redundant call is cheap.
 */
export async function syncBrowsingHistory(
  options: SyncBrowsingHistoryOptions
): Promise<SyncBrowsingHistoryResult> {
  const storeFile = options.storeFile ?? defaultBrowsingFile();
  const limit = options.limit ?? BROWSING_SYNC_LIMIT;
  const store = await readBrowsingStore(storeFile);
  const incoming = await readChromeHistoryVisits(options.historyFile, {
    limit,
    sinceVisitTime: store.lastVisitTimeCursor
  });
  const visits = mergeBrowsingVisits(store.visits, incoming);
  const nextCursor = incoming.reduce(
    (max, v) => Math.max(max, cursorFromBrowsingVisit(v)),
    store.lastVisitTimeCursor
  );
  await writeBrowsingStore(storeFile, { lastVisitTimeCursor: nextCursor, version: store.version, visits });
  return { synced: incoming.length, total: visits.length };
}

/** True when an auto-sync is due (never run, or `intervalMs` has elapsed). Pure — clock is passed in. */
export function shouldAutoSyncBrowsing(
  lastRunMs: number | undefined,
  nowMs: number,
  intervalMs: number
): boolean {
  if (lastRunMs === undefined) return true;
  return nowMs - lastRunMs >= intervalMs;
}
