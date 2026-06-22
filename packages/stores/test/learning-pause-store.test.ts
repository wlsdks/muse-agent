import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isLearningPaused, readLearningPauseState, setLearningPaused } from "../src/learning-pause-store.js";

let files: string[] = [];
const freshFile = () => {
  const f = join(tmpdir(), `muse-pause-${files.length}-${process.pid}.json`);
  files.push(f);
  return f;
};
afterEach(async () => {
  await Promise.all(files.map((f) => rm(f, { force: true })));
  files = [];
});

describe("learning pause switch", () => {
  it("defaults to NOT paused when the file is missing", async () => {
    const f = freshFile();
    expect(await isLearningPaused(f)).toBe(false);
    expect(await readLearningPauseState(f)).toEqual({ paused: false });
  });

  it("round-trips paused + since, and resumes back to not-paused", async () => {
    const f = freshFile();
    await setLearningPaused(f, true, "2026-06-01T00:00:00Z");
    expect(await isLearningPaused(f)).toBe(true);
    expect(await readLearningPauseState(f)).toEqual({ paused: true, since: "2026-06-01T00:00:00Z" });
    await setLearningPaused(f, false);
    expect(await isLearningPaused(f)).toBe(false);
  });

  it("fails OPEN (not paused) on a corrupt file — never silently wedges learning off", async () => {
    const f = freshFile();
    await writeFile(f, "not json", "utf8");
    expect(await isLearningPaused(f)).toBe(false);
  });

  it("treats a non-true paused value as not paused", async () => {
    const f = freshFile();
    await writeFile(f, JSON.stringify({ paused: "yes" }), "utf8");
    expect(await isLearningPaused(f)).toBe(false);
  });
});
