import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { clearCluster, DEFAULT_COOLDOWN_THRESHOLD, fingerprintCluster, recordClusterReject, shouldSkipCluster } from "./reject-ledger.js";

function ledgerFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-cooldown-")), "ledger.json");
}

const NOW = "2026-06-01T00:00:00.000Z";
const cluster = [
  { name: "summarise-email", description: "Use when summarising an email", body: "read; bullets" },
  { name: "summarise-doc", description: "Use when summarising a document", body: "skim; bullets" }
];

describe("fingerprintCluster", () => {
  it("is stable regardless of member order, and changes when any member's content changes", () => {
    const a = fingerprintCluster(cluster);
    const reordered = fingerprintCluster([cluster[1]!, cluster[0]!]);
    expect(reordered).toBe(a); // order-independent
    const editedBody = fingerprintCluster([{ ...cluster[0]!, body: "read; THREE bullets" }, cluster[1]!]);
    expect(editedBody).not.toBe(a); // body edit re-opens
    const editedDesc = fingerprintCluster([{ ...cluster[0]!, description: "Use when summarising email threads" }, cluster[1]!]);
    expect(editedDesc).not.toBe(a); // description edit re-opens
  });
});

describe("reject ledger", () => {
  it("skips only at/after the threshold; a fresh cluster is not skipped", async () => {
    const file = ledgerFile();
    expect(await shouldSkipCluster(file, cluster)).toBe(false); // missing file → empty → not skipped
    await recordClusterReject(file, cluster, NOW);
    expect(await shouldSkipCluster(file, cluster)).toBe(false); // 1 < default 2
    await recordClusterReject(file, cluster, NOW);
    expect(await shouldSkipCluster(file, cluster)).toBe(true); // 2 >= threshold
  });

  it("honors a custom threshold", async () => {
    const file = ledgerFile();
    await recordClusterReject(file, cluster, NOW);
    expect(await shouldSkipCluster(file, cluster, 1)).toBe(true);
    expect(await shouldSkipCluster(file, cluster, 3)).toBe(false);
  });

  it("accumulates every concurrent reject instead of losing cooldown evidence", async () => {
    const file = ledgerFile();
    await Promise.all(Array.from({ length: 8 }, () => recordClusterReject(file, cluster, NOW)));
    expect(await shouldSkipCluster(file, cluster, 8)).toBe(true);
  });

  it("clearCluster resets the count (merged → re-openable)", async () => {
    const file = ledgerFile();
    await recordClusterReject(file, cluster, NOW);
    await recordClusterReject(file, cluster, NOW);
    expect(await shouldSkipCluster(file, cluster)).toBe(true);
    await clearCluster(file, cluster);
    expect(await shouldSkipCluster(file, cluster)).toBe(false);
  });

  it("a content edit re-opens a cooled-down cluster (new fingerprint, count 0)", async () => {
    const file = ledgerFile();
    await recordClusterReject(file, cluster, NOW);
    await recordClusterReject(file, cluster, NOW);
    const edited = [{ ...cluster[0]!, body: "read; FOUR bullets" }, cluster[1]!];
    expect(await shouldSkipCluster(file, edited)).toBe(false); // different fingerprint → not skipped
  });

  it("a different cluster is isolated (its own count)", async () => {
    const file = ledgerFile();
    await recordClusterReject(file, cluster, NOW);
    await recordClusterReject(file, cluster, NOW);
    const other = [{ name: "lock-a", description: "Use when locking A", body: "x" }, { name: "lock-b", description: "Use when locking B", body: "y" }];
    expect(await shouldSkipCluster(file, other)).toBe(false);
  });

  it("fail-soft on a corrupt/missing file (treats as empty, never throws)", async () => {
    const file = ledgerFile();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{ this is not json");
    expect(await shouldSkipCluster(file, cluster)).toBe(false);
    await recordClusterReject(file, cluster, NOW); // recovers by overwriting
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(saved)).toHaveLength(1);
  });

  it("DEFAULT_COOLDOWN_THRESHOLD does not trip on the first reject (feedbackRetry gets a couple of ticks)", () => {
    expect(DEFAULT_COOLDOWN_THRESHOLD).toBeGreaterThanOrEqual(2);
  });
});
