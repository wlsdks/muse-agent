import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  incrementSuppressionBlocked,
  MAX_SUPPRESSED_LESSONS,
  querySuppressedLessons,
  readSuppressedLessons,
  recordSuppressedLesson,
  writeSuppressedLessons,
  type SuppressedLesson
} from "../src/suppressed-lessons-store.js";

const lesson = (id: string, text = "always answer in bullet points"): SuppressedLesson => ({
  id, userId: "u1", text, createdAt: "2026-06-01T00:00:00Z"
});

let files: string[] = [];
const freshFile = () => {
  const f = join(tmpdir(), `muse-suppressed-${files.length}-${process.pid}.json`);
  files.push(f);
  return f;
};
afterEach(async () => {
  await Promise.all(files.map((f) => rm(f, { force: true })));
  files = [];
});

describe("recordSuppressedLesson / readSuppressedLessons / query", () => {
  it("records, reads back, and filters by user", async () => {
    const f = freshFile();
    await recordSuppressedLesson(f, lesson("a"));
    await recordSuppressedLesson(f, { ...lesson("b"), userId: "u2" });
    expect((await readSuppressedLessons(f)).map((e) => e.id)).toEqual(["a", "b"]);
    expect((await querySuppressedLessons(f, "u1")).map((e) => e.id)).toEqual(["a"]);
  });

  it("round-trips the source correction (the matching signal)", async () => {
    const f = freshFile();
    await recordSuppressedLesson(f, { ...lesson("a"), source: "give me bullets, not prose" });
    expect((await readSuppressedLessons(f))[0]?.source).toBe("give me bullets, not prose");
  });

  it("returns [] for missing/corrupt and replaces by id (no dup)", async () => {
    const f = freshFile();
    expect(await readSuppressedLessons(f)).toEqual([]);
    await recordSuppressedLesson(f, lesson("a"));
    await recordSuppressedLesson(f, { ...lesson("a"), text: "updated text" });
    const all = await readSuppressedLessons(f);
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toBe("updated text");
  });

  it("caps at MAX_SUPPRESSED_LESSONS (newest kept)", async () => {
    const f = freshFile();
    // Seed an already-full store in ONE write, then record one more to trip the cap.
    const seeded = Array.from({ length: MAX_SUPPRESSED_LESSONS }, (_u, i) => lesson(`s${i.toString()}`));
    await writeSuppressedLessons(f, seeded);
    await recordSuppressedLesson(f, lesson("newest"));
    const all = await readSuppressedLessons(f);
    expect(all).toHaveLength(MAX_SUPPRESSED_LESSONS);
    expect(all.some((e) => e.id === "newest")).toBe(true); // newest survived
    expect(all.some((e) => e.id === "s0")).toBe(false); // oldest evicted
  });
});

describe("incrementSuppressionBlocked", () => {
  it("bumps the blocked counter; undefined for an absent id", async () => {
    const f = freshFile();
    await recordSuppressedLesson(f, lesson("a"));
    expect(await incrementSuppressionBlocked(f, "a")).toBe(1);
    expect(await incrementSuppressionBlocked(f, "a")).toBe(2);
    expect((await readSuppressedLessons(f))[0]?.blockedCount).toBe(2);
    expect(await incrementSuppressionBlocked(f, "missing")).toBeUndefined();
  });
});
