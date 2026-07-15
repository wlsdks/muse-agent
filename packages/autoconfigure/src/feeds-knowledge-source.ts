import { readFile } from "node:fs/promises";

import { isRecord } from "@muse/shared";

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
  const feeds = isRecord(parsed) ? parsed.feeds : undefined;
  if (!Array.isArray(feeds)) {
    return [];
  }
  const out: FeedEntryLike[] = [];
  for (const feed of feeds) {
    if (!isRecord(feed)) {
      continue;
    }
    const feedName = typeof feed.name === "string" ? feed.name : undefined;
    const entries = feed.entries;
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!isRecord(entry)) {
        continue;
      }
      if (typeof entry.id !== "string" || typeof entry.title !== "string") {
        continue;
      }
      out.push({
        id: entry.id,
        summary: typeof entry.summary === "string" ? entry.summary : "",
        title: entry.title,
        ...(typeof entry.publishedAt === "string" ? { publishedAt: entry.publishedAt } : {}),
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
