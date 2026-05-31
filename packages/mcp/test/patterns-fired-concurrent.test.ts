import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readPatternsFired, recordPatternFired } from "../src/personal-patterns-fired-store.js";

let files: string[] = [];
const freshFile = () => {
  const file = join(tmpdir(), `muse-patterns-fired-${randomUUID()}.json`);
  files.push(file);
  return file;
};
afterEach(async () => { await Promise.all(files.map((f) => rm(f, { force: true }))); files = []; });

// recordPatternFired is a read→append→write. Before it was put on the shared
// per-file mutation queue, concurrent fires lost records (last write clobbered the
// rest — a lost fire skews the pattern's cooldown/cadence) and crashed with ENOENT
// when two writes in the same ms collided on the tmp-${pid}-${Date.now()} path.
describe("recordPatternFired under concurrency", () => {
  it("preserves every concurrently-recorded fire (no lost record, no rename crash)", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 25 }, (_unused, i) => recordPatternFired(file, `pat${i.toString()}`, 1_700_000_000_000 + i)));
    const all = await readPatternsFired(file);
    expect(all).toHaveLength(25);
    expect(new Set(all.map((r) => r.patternId)).size).toBe(25);
  }, 30_000);
});
