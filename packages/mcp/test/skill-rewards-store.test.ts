import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { adjustSkillReward, isSkillAvoided, readSkillRewards, SKILL_AVOID_BELOW, SKILL_REWARD_MAX, SKILL_REWARD_MIN } from "../src/skill-rewards-store.js";

let files: string[] = [];
const freshFile = () => {
  const file = join(tmpdir(), `muse-skill-rewards-${randomUUID()}.json`);
  files.push(file);
  return file;
};
afterEach(async () => {
  await Promise.all(files.map((f) => rm(f, { force: true })));
  files = [];
});

describe("readSkillRewards", () => {
  it("returns {} for a missing or corrupt file, and clamps values on read", async () => {
    expect(await readSkillRewards(freshFile())).toEqual({});
    const corrupt = freshFile();
    await writeFile(corrupt, "{ not json", "utf8");
    expect(await readSkillRewards(corrupt)).toEqual({});
    const ok = freshFile();
    await writeFile(ok, JSON.stringify({ rewards: { "vpn-fix": 99, "noisy": -99, "bad": "x", "": 2 } }), "utf8");
    expect(await readSkillRewards(ok)).toEqual({ "vpn-fix": SKILL_REWARD_MAX, "noisy": SKILL_REWARD_MIN }); // clamped; non-numeric + empty-name dropped
  });
});

describe("adjustSkillReward", () => {
  it("accumulates from absent (0), clamps, and persists per skill", async () => {
    const file = freshFile();
    expect(await adjustSkillReward(file, "a", -1)).toBe(-1);
    expect(await adjustSkillReward(file, "a", -1)).toBe(-2);
    expect(await adjustSkillReward(file, "b", 1)).toBe(1);
    expect(await adjustSkillReward(file, "a", -99)).toBe(SKILL_REWARD_MIN); // clamped at floor
    expect(await readSkillRewards(file)).toEqual({ a: SKILL_REWARD_MIN, b: 1 });
  });

  it("returns undefined for a non-finite delta or empty name (no write)", async () => {
    const file = freshFile();
    expect(await adjustSkillReward(file, "a", Number.NaN)).toBeUndefined();
    expect(await adjustSkillReward(file, "", -1)).toBeUndefined();
    expect(await readSkillRewards(file)).toEqual({});
  });
});

describe("isSkillAvoided", () => {
  it("is true at/below the avoid line, false above or absent", () => {
    expect(isSkillAvoided(SKILL_AVOID_BELOW)).toBe(true);
    expect(isSkillAvoided(SKILL_AVOID_BELOW - 1)).toBe(true);
    expect(isSkillAvoided(SKILL_AVOID_BELOW + 1)).toBe(false);
    expect(isSkillAvoided(undefined)).toBe(false);
  });
});
