import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTION_LOG_GENESIS_HASH,
  appendActionLog,
  computeEntryHash,
  readActionLog,
  verifyActionLogChain,
  verifyActionLogChainFile,
  type ActionLogEntry
} from "../src/personal-action-log-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "action-log-chain-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const entry = (i: number): ActionLogEntry => ({
  id: `a${i.toString()}`,
  result: "performed",
  userId: "u",
  what: `did thing ${i.toString()}`,
  when: `2026-01-0${(i + 1).toString()}T00:00:00Z`,
  why: "because"
});

/** Write a raw entries array to disk, bypassing the chaining append (for tamper simulation). */
async function writeRaw(file: string, entries: readonly ActionLogEntry[]): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
}

describe("action-log hash-chain — tamper evidence", () => {
  it("appends a verifiable chain: first entry chains to genesis, each to its predecessor", async () => {
    const file = join(dir, "actions.json");
    for (let i = 0; i < 5; i += 1) await appendActionLog(file, entry(i));
    const entries = await readActionLog(file);
    expect(entries).toHaveLength(5);
    expect(entries[0]!.prevHash).toBe(ACTION_LOG_GENESIS_HASH);
    expect(entries[1]!.prevHash).toBe(computeEntryHash(entries[0]!, ACTION_LOG_GENESIS_HASH));
    const result = verifyActionLogChain(entries);
    expect(result.ok).toBe(true);
    expect(result.linkedEntries).toBe(5);
    expect(result.brokenAtIndex).toBeNull();
  });

  it("verifyActionLogChainFile reports an intact freshly-appended log", async () => {
    const file = join(dir, "actions.json");
    for (let i = 0; i < 3; i += 1) await appendActionLog(file, entry(i));
    const result = await verifyActionLogChainFile(file);
    expect(result.ok).toBe(true);
    expect(result.linkedEntries).toBe(3);
  });

  it("detects an IN-PLACE edit of a historical entry at the next link", async () => {
    const file = join(dir, "actions.json");
    for (let i = 0; i < 5; i += 1) await appendActionLog(file, entry(i));
    const entries = [...(await readActionLog(file))];
    // Tamper: rewrite entry 2's `what` but leave its prevHash — the chain detects
    // it at entry 3 (whose prevHash no longer matches the altered entry 2's hash).
    entries[2] = { ...entries[2]!, what: "SECRETLY ALTERED" };
    await writeRaw(file, entries);
    const result = await verifyActionLogChainFile(file);
    expect(result.ok).toBe(false);
    expect(result.brokenAtIndex).toBe(3);
    expect(result.reason).toContain("does not chain");
  });

  it("detects a DELETED middle entry", async () => {
    const file = join(dir, "actions.json");
    for (let i = 0; i < 5; i += 1) await appendActionLog(file, entry(i));
    const entries = (await readActionLog(file)).filter((_e, i) => i !== 2); // drop index 2
    await writeRaw(file, entries);
    const result = await verifyActionLogChainFile(file);
    expect(result.ok).toBe(false);
    expect(result.brokenAtIndex).toBe(2); // old entry 3, now at index 2, no longer chains
  });

  it("detects REORDERED entries", async () => {
    const file = join(dir, "actions.json");
    for (let i = 0; i < 4; i += 1) await appendActionLog(file, entry(i));
    const entries = [...(await readActionLog(file))];
    [entries[1], entries[2]] = [entries[2]!, entries[1]!];
    await writeRaw(file, entries);
    const result = await verifyActionLogChain(entries);
    expect(result.ok).toBe(false);
    expect(result.brokenAtIndex).toBe(1);
  });

  it("detects a BACKDATED `when` on a historical entry", async () => {
    const file = join(dir, "actions.json");
    for (let i = 0; i < 4; i += 1) await appendActionLog(file, entry(i));
    const entries = [...(await readActionLog(file))];
    entries[1] = { ...entries[1]!, when: "2020-01-01T00:00:00Z" }; // backdate
    const result = verifyActionLogChain(entries);
    expect(result.ok).toBe(false);
    expect(result.brokenAtIndex).toBe(2);
  });

  it("legacy entries with NO prevHash verify as an intact pre-chain prefix", async () => {
    const file = join(dir, "actions.json");
    // Two legacy entries (no prevHash), as an older Muse would have written.
    await writeRaw(file, [entry(0), entry(1)]);
    const legacy = await verifyActionLogChainFile(file);
    expect(legacy.ok).toBe(true);
    expect(legacy.linkedEntries).toBe(0);
    expect(legacy.reason).toContain("legacy");
  });

  it("a new append onto a legacy log starts a verifiable chain from the legacy tip", async () => {
    const file = join(dir, "actions.json");
    await writeRaw(file, [entry(0), entry(1)]); // legacy prefix
    await appendActionLog(file, entry(2)); // first chained
    await appendActionLog(file, entry(3));
    const entries = await readActionLog(file);
    expect(entries[0]!.prevHash).toBeUndefined();
    expect(entries[2]!.prevHash).toBe(computeEntryHash(entries[1]!, ACTION_LOG_GENESIS_HASH));
    const result = verifyActionLogChain(entries);
    expect(result.ok).toBe(true);
    expect(result.linkedEntries).toBe(2); // the two chained entries
  });

  it("detects an entry SLICED OUT of the chained region (missing link after the chain began)", async () => {
    const file = join(dir, "actions.json");
    for (let i = 0; i < 4; i += 1) await appendActionLog(file, entry(i));
    const entries = [...(await readActionLog(file))];
    // Strip the prevHash off entry 2 (as if an attacker pasted in a legacy-shaped entry mid-chain).
    entries[2] = { ...entries[2]!, prevHash: undefined };
    const result = verifyActionLogChain(entries);
    expect(result.ok).toBe(false);
    expect(result.brokenAtIndex).toBe(2);
    expect(result.reason).toContain("no chain link");
  });

  it("an empty / missing log is vacuously intact", async () => {
    expect((await verifyActionLogChainFile(join(dir, "absent.json"))).ok).toBe(true);
    expect(verifyActionLogChain([]).ok).toBe(true);
  });
});
