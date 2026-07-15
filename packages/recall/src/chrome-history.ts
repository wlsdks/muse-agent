/**
 * Read the user's LOCAL Chrome browsing history straight out of the
 * `History` SQLite file into `BrowsingVisit[]`. 100% local, zero egress,
 * zero new dependencies — uses the built-in `node:sqlite`.
 *
 * Two hard constraints shape this module:
 *   1. Chrome holds a lock on the live `History` file, so it is copied
 *      to a temp path and the COPY is opened read-only. The original is
 *      never touched.
 *   2. Ingestion is fail-soft: a missing / unreadable / non-sqlite file,
 *      or a schema that lacks the expected tables, yields `[]` and never
 *      throws out of the public API — this is an ingestion source, not a
 *      security gate.
 */

import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@muse/shared";

import type { BrowsingVisit } from "./browsing-store.js";
import { webkitTimeToIso } from "./browsing-store.js";

/** Only these schemes are ingested — everything else (chrome://, extensions, data:, file:) is dropped. */
const INGESTIBLE_SCHEME = /^https?:\/\//iu;

/** Drop pathological URLs (data: blobs pasted into the bar, tracking megastrings). */
const MAX_URL_LENGTH = 2000;

export interface LocateChromeHistoryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

/**
 * Resolve the Chrome `History` file path. `MUSE_CHROME_HISTORY_FILE`
 * wins (makes tests + Chromium-fork users work); otherwise the macOS
 * default profile path, with `MUSE_CHROME_PROFILE` swapping "Default"
 * for e.g. "Profile 1". Returns `undefined` if the resolved file does
 * not exist (fail-soft).
 */
export async function locateChromeHistoryFile(
  options: LocateChromeHistoryOptions = {}
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const override = env.MUSE_CHROME_HISTORY_FILE?.trim();
  const candidate =
    override && override.length > 0
      ? override
      : join(
          home,
          "Library",
          "Application Support",
          "Google",
          "Chrome",
          env.MUSE_CHROME_PROFILE?.trim() || "Default",
          "History"
        );
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

export interface ReadChromeHistoryOptions {
  /** WebKit-epoch µs cursor; only visits strictly newer are returned. Default 0 (all). */
  readonly sinceVisitTime?: number;
  /** Max rows to read in one pass. Default 2000. */
  readonly limit?: number;
}

interface RawVisitRow {
  readonly visit_id: bigint;
  readonly url: string;
  readonly title: string | null;
  // Chrome stores WebKit-epoch µs (~1.3e16), which exceeds Number.MAX_SAFE_INTEGER,
  // so node:sqlite hands it back as a BigInt (setReadBigInts below).
  readonly visit_time: bigint;
}

const HISTORY_QUERY =
  "SELECT visits.id AS visit_id, urls.url AS url, urls.title AS title, visits.visit_time AS visit_time " +
  "FROM visits JOIN urls ON visits.url = urls.id " +
  "WHERE visits.visit_time > ? ORDER BY visits.visit_time ASC LIMIT ?";

/**
 * Read visits newer than `sinceVisitTime` from the given History file.
 * Copies the (locked) file to a temp path, opens the copy read-only,
 * queries, and unlinks the copy in a `finally`. Applies the
 * scheme/length/empty-title hygiene filters in code. Fail-soft: any
 * error collapses to `[]`.
 */
export async function readChromeHistoryVisits(
  historyFile: string,
  options: ReadChromeHistoryOptions = {}
): Promise<readonly BrowsingVisit[]> {
  const sinceVisitTimeCandidate = options.sinceVisitTime ?? Number.NaN;
  const sinceVisitTime = Number.isFinite(sinceVisitTimeCandidate) ? sinceVisitTimeCandidate : 0;

  const limitCandidate = options.limit ?? 0;
  const limit = Number.isFinite(limitCandidate) && limitCandidate > 0 ? Math.trunc(limitCandidate) : 2000;

  const tempCopy = join(tmpdir(), `muse-chrome-history-${process.pid.toString()}-${Date.now().toString()}-${Math.random().toString(36).slice(2)}.sqlite`);
  let rows: readonly RawVisitRow[];
  try {
    await fs.copyFile(historyFile, tempCopy);
  } catch {
    return [];
  }
  try {
    rows = await queryVisits(tempCopy, sinceVisitTime, limit);
  } catch {
    return [];
  } finally {
    await fs.unlink(tempCopy).catch(() => undefined);
  }
  return rows.flatMap((row) => toBrowsingVisit(row));
}

// `node:sqlite` is imported LAZILY (inside the one function that uses it) rather
// than at module top level. Loaded eagerly it would run on ANY import of this
// module's package graph — including at process startup for every CLI command —
// and a runtime WITHOUT node:sqlite (the bun-compiled desktop binary; Bun lacks
// the built-in) would then hard-crash the entire binary before it ran anything.
// Deferring it here means only actual Chrome-history ingestion pays that cost,
// and its failure collapses to the caller's fail-soft `[]`.
async function queryVisits(dbFile: string, sinceVisitTime: number, limit: number): Promise<readonly RawVisitRow[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const statement = db.prepare(HISTORY_QUERY);
    // WebKit-epoch µs overflows a JS number, so read + bind integers as BigInt.
    statement.setReadBigInts(true);
    const cursor = BigInt(Math.max(0, Math.round(sinceVisitTime)));
    const rows: readonly unknown[] = statement.all(cursor, limit);
    return rows.filter(isRawVisitRow);
  } finally {
    db.close();
  }
}

function isRawVisitRow(row: unknown): row is RawVisitRow {
  if (!isRecord(row)) {
    return false;
  }
  if (typeof row.visit_id !== "bigint" || typeof row.visit_time !== "bigint" || typeof row.url !== "string") {
    return false;
  }
  return row.title === null || typeof row.title === "string";
}

function toBrowsingVisit(row: RawVisitRow): readonly BrowsingVisit[] {
  const url = typeof row.url === "string" ? row.url : "";
  if (!INGESTIBLE_SCHEME.test(url)) return [];
  if (url.length > MAX_URL_LENGTH) return [];
  if (typeof row.visit_time !== "bigint" || row.visit_time <= 0n) return [];
  const rawTitle = typeof row.title === "string" ? row.title.trim() : "";
  const title = rawTitle.length > 0 ? rawTitle : hostnameOf(url);
  return [
    {
      id: `${row.visit_time.toString()}-${hashUrl(url)}`,
      url,
      title,
      visitedAt: webkitTimeToIso(Number(row.visit_time))
    }
  ];
}

/** Best-effort hostname for a title fallback; the whole URL if it won't parse. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** FNV-1a 32-bit hex — a short, stable, collision-resistant tag so a re-sync of the same visit yields the same id. */
function hashUrl(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
