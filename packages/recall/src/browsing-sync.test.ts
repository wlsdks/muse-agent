import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readBrowsingStore } from "./browsing-store.js";
import { cursorFromBrowsingVisit, shouldAutoSyncBrowsing, syncBrowsingHistory } from "./browsing-sync.js";

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
