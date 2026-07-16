import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readBrowsingStore, type BrowsingVisit } from "./browsing-store.js";
import { BROWSING_BACKFILL_CAP, cursorFromBrowsingVisit, embedBrowsingVisits, shouldAutoSyncBrowsing, syncBrowsingHistory } from "./browsing-sync.js";

interface SeedRow {
  readonly id: number;
  readonly url: string;
  readonly title: string | null;
  readonly visitTime: number;
}

function buildFixtureDb(file: string, rows: readonly SeedRow[]): void {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER)");
  db.exec("CREATE TABLE IF NOT EXISTS visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)");
  const insertUrl = db.prepare("INSERT INTO urls(id, url, title, visit_count) VALUES(?, ?, ?, 1)");
  const insertVisit = db.prepare("INSERT INTO visits(id, url, visit_time) VALUES(?, ?, ?)");
  for (const row of rows) {
    insertUrl.run(row.id, row.url, row.title);
    insertVisit.run(row.id, row.id, BigInt(row.visitTime));
  }
  db.close();
}

const CURSOR = 13_390_000_000_000_000;

describe("syncBrowsingHistory — shared command + daemon sync core", () => {
  let dir: string;
  let historyFile: string;
  let storeFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-browsing-sync-"));
    historyFile = join(dir, "History");
    storeFile = join(dir, "browsing.json");
    buildFixtureDb(historyFile, [
      { id: 1, url: "https://blog.example/rust", title: "Rust ownership guide", visitTime: CURSOR + 2_000_000 },
      { id: 2, url: "https://news.example/ai", title: "AI news", visitTime: CURSOR + 4_000_000 },
      { id: 3, url: "chrome://settings", title: "Settings", visitTime: CURSOR + 5_000_000 }
    ]);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("ingests new http(s) visits into a fresh archive and reports the counts", async () => {
    const result = await syncBrowsingHistory({ historyFile, limit: 100, storeFile });
    expect(result.synced).toBe(2); // chrome:// dropped by the chrome-history hygiene filter
    expect(result.total).toBe(2);
    const store = await readBrowsingStore(storeFile);
    expect(store.visits.map((v) => v.url).sort()).toEqual(["https://blog.example/rust", "https://news.example/ai"]);
    expect(store.lastVisitTimeCursor).toBe(CURSOR + 4_000_000); // advanced to the newest ingested visit
  });

  it("is incremental + idempotent: a second sync of an unchanged History adds nothing", async () => {
    await syncBrowsingHistory({ historyFile, limit: 100, storeFile });
    const second = await syncBrowsingHistory({ historyFile, limit: 100, storeFile });
    expect(second.synced).toBe(0);
    expect(second.total).toBe(2);
  });

  it("picks up ONLY the rows newer than the stored cursor on a re-sync", async () => {
    await syncBrowsingHistory({ historyFile, limit: 100, storeFile });
    buildFixtureDb(historyFile, [
      { id: 4, url: "https://blog.example/newer", title: "Newer post", visitTime: CURSOR + 9_000_000 }
    ]);
    const result = await syncBrowsingHistory({ historyFile, limit: 100, storeFile });
    expect(result.synced).toBe(1);
    expect(result.total).toBe(3);
    const store = await readBrowsingStore(storeFile);
    expect(store.lastVisitTimeCursor).toBe(CURSOR + 9_000_000);
  });

  it("embeds new visits when an embedder is provided (search_document-prefixed title)", async () => {
    const seen: string[] = [];
    const embed = async (text: string): Promise<readonly number[]> => {
      seen.push(text);
      return [0.1, 0.2, 0.3];
    };
    await syncBrowsingHistory({ embed, historyFile, limit: 100, storeFile });
    const store = await readBrowsingStore(storeFile);
    expect(store.visits.every((v) => v.embedding && v.embedding.length === 3)).toBe(true);
    expect(seen).toContain("search_document: Rust ownership guide");
  });

  it("stores visits WITHOUT an embedding when no embedder is provided (unchanged default)", async () => {
    await syncBrowsingHistory({ historyFile, limit: 100, storeFile });
    const store = await readBrowsingStore(storeFile);
    expect(store.visits.every((v) => v.embedding === undefined)).toBe(true);
  });

  it("is fail-soft: an embedder that throws still ingests every visit (just unembedded)", async () => {
    const embed = async (): Promise<readonly number[]> => {
      throw new Error("ollama down");
    };
    const result = await syncBrowsingHistory({ embed, historyFile, limit: 100, storeFile });
    expect(result.synced).toBe(2); // sync did NOT fail
    const store = await readBrowsingStore(storeFile);
    expect(store.visits).toHaveLength(2);
    expect(store.visits.every((v) => v.embedding === undefined)).toBe(true);
  });

  it("merges a delayed sync into a newer committed snapshot without regressing the cursor", async () => {
    let signalEmbedStart: (() => void) | undefined;
    let releaseEmbed: (() => void) | undefined;
    const embedStarted = new Promise<void>((resolve) => { signalEmbedStart = resolve; });
    const embedGate = new Promise<void>((resolve) => { releaseEmbed = resolve; });
    const delayedEmbed = async (): Promise<readonly number[]> => {
      signalEmbedStart?.();
      await embedGate;
      return [0.1, 0.2];
    };

    const delayed = syncBrowsingHistory({ embed: delayedEmbed, historyFile, limit: 100, storeFile });
    await embedStarted;
    buildFixtureDb(historyFile, [
      { id: 4, url: "https://blog.example/newer", title: "Newer post", visitTime: CURSOR + 9_000_000 }
    ]);
    await syncBrowsingHistory({ historyFile, limit: 100, storeFile });
    releaseEmbed?.();
    await delayed;

    const store = await readBrowsingStore(storeFile);
    expect(store.visits.map((visit) => visit.url).sort()).toEqual([
      "https://blog.example/newer",
      "https://blog.example/rust",
      "https://news.example/ai"
    ]);
    expect(store.lastVisitTimeCursor).toBe(CURSOR + 9_000_000);
  });
});

describe("embedBrowsingVisits — bounded, fail-soft embed pass", () => {
  const mk = (id: string, embedding?: readonly number[]): BrowsingVisit => ({
    id, url: `https://x/${id}`, title: `t-${id}`, visitedAt: "2026-05-19T00:00:00.000Z", ...(embedding ? { embedding } : {})
  });
  const embed = async (): Promise<readonly number[]> => [1, 2, 3];

  it("embeds all NEW (incoming) visits, and bounds backfill of old ones at the cap", async () => {
    // 1 new incoming + 3 old un-embedded; backfillCap 1 → new embedded, only 1 old backfilled.
    const visits = [mk("new1"), mk("old1"), mk("old2"), mk("old3")];
    const out = await embedBrowsingVisits(visits, embed, { incomingIds: new Set(["new1"]), backfillCap: 1 });
    expect(out.find((v) => v.id === "new1")!.embedding).toEqual([1, 2, 3]); // new always embedded
    const backfilled = out.filter((v) => v.id.startsWith("old") && v.embedding !== undefined);
    expect(backfilled).toHaveLength(1); // backfill bounded at the cap
  });

  it("skips a visit that already has an embedding (no re-embed)", async () => {
    let calls = 0;
    const counting = async (): Promise<readonly number[]> => { calls += 1; return [9]; };
    const out = await embedBrowsingVisits([mk("has", [0.5])], counting, { incomingIds: new Set() });
    expect(calls).toBe(0);
    expect(out[0]!.embedding).toEqual([0.5]);
  });

  it("is fail-soft per visit: an embed error keeps the visit without an embedding", async () => {
    const throwing = async (): Promise<readonly number[]> => { throw new Error("boom"); };
    const out = await embedBrowsingVisits([mk("a")], throwing, { incomingIds: new Set(["a"]) });
    expect(out).toHaveLength(1);
    expect(out[0]!.embedding).toBeUndefined();
  });

  it("defaults backfillCap to BROWSING_BACKFILL_CAP", () => {
    expect(BROWSING_BACKFILL_CAP).toBe(200);
  });
});

describe("shouldAutoSyncBrowsing — throttle decision (clock injected)", () => {
  const INTERVAL = 60 * 60 * 1000;
  it("is due when never run", () => {
    expect(shouldAutoSyncBrowsing(undefined, 1_000, INTERVAL)).toBe(true);
  });
  it("is NOT due again inside the interval (two ticks close together ⇒ one sync)", () => {
    const last = 1_000_000;
    expect(shouldAutoSyncBrowsing(last, last + 5 * 60 * 1000, INTERVAL)).toBe(false);
  });
  it("is due again once the interval has elapsed", () => {
    const last = 1_000_000;
    expect(shouldAutoSyncBrowsing(last, last + INTERVAL, INTERVAL)).toBe(true);
    expect(shouldAutoSyncBrowsing(last, last + INTERVAL + 1, INTERVAL)).toBe(true);
  });
});

describe("cursorFromBrowsingVisit", () => {
  it("parses the WebKit-µs prefix from the `<micros>-<hash>` id", () => {
    expect(cursorFromBrowsingVisit({ id: "13390000002000000-abcd1234", url: "u", title: "t", visitedAt: "2026" })).toBe(13_390_000_002_000_000);
  });
  it("falls back to 0 for an unparseable id", () => {
    expect(cursorFromBrowsingVisit({ id: "not-a-number", url: "u", title: "t", visitedAt: "2026" })).toBe(0);
  });
});
