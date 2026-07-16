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
  browsingDocEmbedText,
  defaultBrowsingFile,
  mergeBrowsingVisits,
  mutateBrowsingStore,
  readBrowsingStore,
  roundVectorForStore
} from "./browsing-store.js";
import { readChromeHistoryVisits } from "./chrome-history.js";

/** Max visits read from Chrome per sync — bounds a single pass over a large History file. */
export const BROWSING_SYNC_LIMIT = 2000;

/**
 * Per-run cap on RE-embedding already-stored, not-yet-embedded visits (newest
 * first). Fresh incoming visits are ALWAYS embedded; this bounds only the
 * backfill so a pre-3b archive converges over several runs instead of one giant
 * stall. Each embed is fail-soft, so even a full budget never breaks a sync.
 */
export const BROWSING_BACKFILL_CAP = 200;

export interface SyncBrowsingHistoryOptions {
  /** Located Chrome `History` file (callers locate first — see `locateChromeHistoryFile`). */
  readonly historyFile: string;
  /** Destination archive; defaults to `~/.muse/browsing.json`. */
  readonly storeFile?: string;
  /** Max rows to read this pass. Default `BROWSING_SYNC_LIMIT`. */
  readonly limit?: number;
  /**
   * OPTIONAL title embedder (localhost only — the existing embed seam). When
   * provided, new visits are embedded at ingest + a bounded backfill of old ones.
   * When ABSENT, or when an individual embed throws, the visit is stored WITHOUT
   * an embedding — a sync NEVER fails because Ollama is down (fail-soft, pinned by
   * test). The caller applies the `search_document:` prefix (`browsingDocEmbedText`).
   */
  readonly embed?: (text: string) => Promise<readonly number[]>;
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
 * Embed the titles of `visits` that lack an embedding, newest-first. Fresh
 * `incomingIds` are ALWAYS embedded; older visits consume a bounded `backfillCap`
 * budget so a large pre-3b archive converges gradually. Per-visit fail-soft: an
 * embed error keeps the visit WITHOUT an embedding (the sync never fails because
 * Ollama is down). Pure mechanism — the embedder is injected. Visits keep their
 * input order (merge already sorted them newest-first).
 */
export async function embedBrowsingVisits(
  visits: readonly BrowsingVisit[],
  embed: (text: string) => Promise<readonly number[]>,
  opts: { readonly incomingIds: ReadonlySet<string>; readonly backfillCap?: number }
): Promise<readonly BrowsingVisit[]> {
  const backfillCap = opts.backfillCap ?? BROWSING_BACKFILL_CAP;
  let backfillUsed = 0;
  const out: BrowsingVisit[] = [];
  for (const visit of visits) {
    if (visit.embedding && visit.embedding.length > 0) {
      out.push(visit);
      continue;
    }
    const isNew = opts.incomingIds.has(visit.id);
    if (!isNew && backfillUsed >= backfillCap) {
      out.push(visit);
      continue;
    }
    try {
      const vec = await embed(browsingDocEmbedText(visit));
      out.push({ ...visit, embedding: roundVectorForStore(vec) });
      if (!isNew) backfillUsed += 1;
    } catch {
      out.push(visit); // fail-soft: store without an embedding, never abort the sync
    }
  }
  return out;
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
  const merged = mergeBrowsingVisits(store.visits, incoming);
  const visits = options.embed
    ? await embedBrowsingVisits(merged, options.embed, { incomingIds: new Set(incoming.map((v) => v.id)) })
    : merged;
  const preparedById = new Map(visits.map((visit) => [visit.id, visit]));
  const committed = await mutateBrowsingStore(storeFile, (latest) => {
    const mergedLatest = mergeBrowsingVisits(latest.visits, incoming);
    const mergedWithEmbeddings = mergedLatest.map((visit) => {
      const prepared = preparedById.get(visit.id);
      return prepared?.title === visit.title && prepared.embedding && !visit.embedding
        ? { ...visit, embedding: prepared.embedding }
        : visit;
    });
    const nextCursor = incoming.reduce(
      (max, visit) => Math.max(max, cursorFromBrowsingVisit(visit)),
      latest.lastVisitTimeCursor
    );
    return { lastVisitTimeCursor: nextCursor, version: latest.version, visits: mergedWithEmbeddings };
  });
  return { synced: incoming.length, total: committed.visits.length };
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
