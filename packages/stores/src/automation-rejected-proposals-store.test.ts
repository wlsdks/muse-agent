import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readRejectedProposals,
  recordRejectedProposal,
  rejectedProposalIds,
  writeRejectedProposals
} from "./automation-rejected-proposals-store.js";

describe("automation-rejected-proposals-store", () => {
  const dirs: string[] = [];

  async function fixture(): Promise<{ readonly dir: string; readonly file: string }> {
    const dir = await mkdtemp(join(tmpdir(), "muse-rejected-proposals-"));
    dirs.push(dir);
    return { dir, file: join(dir, "automation-rejected-proposals.json") };
  }

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("reads an empty list from a missing file", async () => {
    const { file } = await fixture();
    expect(await readRejectedProposals(file)).toEqual([]);
  });

  it("round-trips a write/read", async () => {
    const { file } = await fixture();
    await writeRejectedProposals(file, [{ id: "p1", rejectedAt: "2026-07-18T00:00:00.000Z" }]);
    expect(await readRejectedProposals(file)).toEqual([{ id: "p1", rejectedAt: "2026-07-18T00:00:00.000Z" }]);
  });

  it("recordRejectedProposal appends a new id", async () => {
    const { file } = await fixture();
    await recordRejectedProposal(file, "p1", "2026-07-18T00:00:00.000Z");
    await recordRejectedProposal(file, "p2", "2026-07-18T01:00:00.000Z");
    const all = await readRejectedProposals(file);
    expect(all.map((e) => e.id).sort()).toEqual(["p1", "p2"]);
  });

  it("recordRejectedProposal is idempotent on id — replaces rather than duplicates", async () => {
    const { file } = await fixture();
    await recordRejectedProposal(file, "p1", "2026-07-18T00:00:00.000Z");
    await recordRejectedProposal(file, "p1", "2026-07-18T05:00:00.000Z");
    const all = await readRejectedProposals(file);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({ id: "p1", rejectedAt: "2026-07-18T05:00:00.000Z" });
  });

  it("rejectedProposalIds extracts just the ids", async () => {
    const entries = [
      { id: "p1", rejectedAt: "2026-07-18T00:00:00.000Z" },
      { id: "p2", rejectedAt: "2026-07-18T01:00:00.000Z" }
    ];
    expect(rejectedProposalIds(entries)).toEqual(["p1", "p2"]);
  });

  it("a corrupt (non-JSON) store quarantines and reads as empty rather than throwing", async () => {
    const { file } = await fixture();
    await writeFile(file, "{not json", "utf8");
    expect(await readRejectedProposals(file)).toEqual([]);
  });

  it("a store missing the `rejected` array quarantines and reads as empty", async () => {
    const { file } = await fixture();
    await writeFile(file, JSON.stringify({ notRejected: [] }), "utf8");
    expect(await readRejectedProposals(file)).toEqual([]);
  });

  it("drops a malformed entry (missing id) rather than throwing", async () => {
    const { file } = await fixture();
    await writeFile(file, JSON.stringify({ rejected: [{ rejectedAt: "x" }, { id: "ok", rejectedAt: "y" }] }), "utf8");
    expect(await readRejectedProposals(file)).toEqual([{ id: "ok", rejectedAt: "y" }]);
  });

  it("write is atomic — the file exists and parses on disk exactly as written", async () => {
    const { file } = await fixture();
    await writeRejectedProposals(file, [{ id: "p1", rejectedAt: "2026-07-18T00:00:00.000Z" }]);
    const raw = await readFile(file, "utf8");
    expect(JSON.parse(raw)).toEqual({ rejected: [{ id: "p1", rejectedAt: "2026-07-18T00:00:00.000Z" }] });
  });
});
