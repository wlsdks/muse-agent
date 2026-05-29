import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readCheckins } from "@muse/mcp";

import { checkinsFile, scanSessionCheckins } from "./commands-checkins.js";

describe("checkinsFile", () => {
  it("honours MUSE_CHECKINS_FILE, else defaults under ~/.muse/checkins.json", () => {
    expect(checkinsFile({ MUSE_CHECKINS_FILE: "/tmp/c.json" } as NodeJS.ProcessEnv)).toBe("/tmp/c.json");
    expect(checkinsFile({} as NodeJS.ProcessEnv).endsWith("/.muse/checkins.json")).toBe(true);
  });
});

describe("scanSessionCheckins — session-end auto-scan (detect → schedule → persist)", () => {
  it("schedules a check-in for a voiced commitment; a no-commitment session schedules none", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-autoscan-")), "checkins.json");
    const withCommitment = await scanSessionCheckins({
      file,
      userId: "stark",
      now: () => new Date("2026-05-01T09:00:00Z"),
      readHistory: async () => [
        { role: "user", content: "I need to email Bob about the Q3 report" },
        { role: "assistant", content: "Got it." }
      ]
    });
    expect(withCommitment).toHaveLength(1);
    expect(withCommitment[0]!.question).toContain("email Bob");
    expect((await readCheckins(file)).map((c) => c.status)).toEqual(["scheduled"]);

    const noCommitment = await scanSessionCheckins({
      file,
      userId: "stark",
      now: () => new Date("2026-05-01T09:05:00Z"),
      readHistory: async () => [{ role: "user", content: "what time is it?" }]
    });
    expect(noCommitment).toEqual([]);
  });
});
