import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isPatternDismissed,
  readPatternsFired,
  writePatternsFired,
  type PatternFiredRecord
} from "../src/personal-patterns-fired-store.js";

let files: string[] = [];
const freshFile = () => {
  const file = join(tmpdir(), `muse-patterns-trim-${randomUUID()}.json`);
  files.push(file);
  return file;
};
afterEach(async () => { await Promise.all(files.map((f) => rm(f, { force: true }))); files = []; });

const MAX = 2_000;

// writePatternsFired FIFO-trims to MAX_FIRED_ENTRIES. A naive slice() of the
// most recent N drops the OLDEST records first — including a dismissal (learned
// avoidance). After enough newer fires the veto is evicted and Muse resumes
// suggesting a pattern the user explicitly silenced. Dismissals must survive.
describe("writePatternsFired trim preserves dismissals (learned avoidance)", () => {
  it("keeps an old dismissal even when far more than MAX newer fires accrue", async () => {
    const file = freshFile();
    const records: PatternFiredRecord[] = [
      { dismissed: true, firedAtMs: 1, patternId: "vetoed-pat" },
      ...Array.from({ length: MAX + 50 }, (_u, i): PatternFiredRecord => ({
        firedAtMs: 1_000 + i,
        patternId: `fire${i.toString()}`
      }))
    ];
    await writePatternsFired(file, records);
    const all = await readPatternsFired(file);

    // The dismissal — the very first (oldest) record — must still be present.
    expect(isPatternDismissed(all, "vetoed-pat")).toBe(true);
    // Plain fires are still FIFO-trimmed to the cap.
    const fires = all.filter((r) => r.dismissed !== true);
    expect(fires.length).toBe(MAX);
  });

  it("does not alter records below the cap", async () => {
    const file = freshFile();
    const records: PatternFiredRecord[] = [
      { dismissed: true, firedAtMs: 1, patternId: "d" },
      { firedAtMs: 2, patternId: "f" }
    ];
    await writePatternsFired(file, records);
    const all = await readPatternsFired(file);
    expect(all).toHaveLength(2);
    expect(isPatternDismissed(all, "d")).toBe(true);
  });
});
