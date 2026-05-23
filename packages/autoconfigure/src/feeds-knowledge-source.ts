import { readFile } from "node:fs/promises";

import type { FeedEntryLike } from "./knowledge-corpus.js";

/**
 * Read already-fetched RSS/Atom entries out of the CLI's feeds store
 * (`~/.muse/feeds.json`, written by `muse feeds refresh`) and flatten
 * them into the shape the knowledge corpus wants, newest first. The
 * XML fetch/parse stays in the CLI — this only reads the persisted
 * JSON, so the watched feeds become answerable via `knowledge_search`.
 *
 * Fail-open: a missing / malformed store yields `[]` (a partial corpus
 * still grounds an answer) — never throws into the search path.
 */
export async function readFeedKnowledgeEntries(file: string, limit: number): Promise<FeedEntryLike[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const feeds = (parsed as { feeds?: unknown })?.feeds;
  if (!Array.isArray(feeds)) {
    return [];
  }
  const out: FeedEntryLike[] = [];
  for (const feed of feeds) {
    const feedName = typeof (feed as { name?: unknown })?.name === "string" ? (feed as { name: string }).name : undefined;
    const entries = (feed as { entries?: unknown })?.entries;
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      const e = entry as { id?: unknown; title?: unknown; summary?: unknown; publishedAt?: unknown };
      if (typeof e.id !== "string" || typeof e.title !== "string") {
        continue;
      }
      out.push({
        id: e.id,
        summary: typeof e.summary === "string" ? e.summary : "",
        title: e.title,
        ...(typeof e.publishedAt === "string" ? { publishedAt: e.publishedAt } : {}),
        ...(feedName ? { feedName } : {})
      });
    }
  }
  out.sort((a, b) => feedEntryTime(b) - feedEntryTime(a));
  return out.slice(0, Math.max(1, Math.trunc(limit)));
}

/** Epoch ms of an entry's `publishedAt`, or `-Infinity` when missing / unparseable (sorts last). */
function feedEntryTime(entry: FeedEntryLike): number {
  const t = entry.publishedAt ? Date.parse(entry.publishedAt) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}
