import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCheckins, writeCheckins, type PersistedCheckin } from "@muse/proactivity";
import { Command } from "commander";

import { checkinsFile, registerCheckinsCommands, scanSessionCheckins } from "./commands-checkins.js";

function checkin(overrides: Partial<PersistedCheckin>): PersistedCheckin {
  return {
    id: "c",
    userId: "stark",
    commitment: "x",
    question: "x",
    dueAtIso: "2026-05-22T12:00:00.000Z",
    createdAt: "2026-05-22T00:00:00.000Z",
    status: "scheduled",
    sourceKey: "x",
    ...overrides
  };
}

async function runCheckins(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prevExit = process.exitCode;
  process.exitCode = 0;
  try {
    const program = new Command();
    program.exitOverride();
    registerCheckinsCommands(program, io);
    await program.parseAsync(["node", "muse", "checkins", ...args]);
  } finally { /* leave exitCode for the caller to read */ }
  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = prevExit;
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

describe("checkins list --status — strict validation (sibling parity with `tasks list`)", () => {
  const prevEnv = process.env.MUSE_CHECKINS_FILE;
  beforeEach(() => {
    process.env.MUSE_CHECKINS_FILE = join(mkdtempSync(join(tmpdir(), "muse-checkins-")), "checkins.json");
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_CHECKINS_FILE;
    else process.env.MUSE_CHECKINS_FILE = prevEnv;
  });

  it("rejects a typo'd --status with an actionable error + exit 1, not a silently-empty list", async () => {
    const r = await runCheckins(["list", "--status", "fierd"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--status must be one of: scheduled, fired, all");
    expect(r.stderr).toContain("did you mean 'fired'");
    expect(r.stdout).not.toContain("No fierd check-ins");
  });

  it("accepts a valid --status without erroring", async () => {
    const r = await runCheckins(["list", "--status", "fired"]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toBe("");
  });
});

describe("checkins list --search — filter by question text (sibling parity with followup/tasks/remind)", () => {
  const prevEnv = process.env.MUSE_CHECKINS_FILE;
  beforeEach(() => {
    process.env.MUSE_CHECKINS_FILE = join(mkdtempSync(join(tmpdir(), "muse-checkins-")), "checkins.json");
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_CHECKINS_FILE;
    else process.env.MUSE_CHECKINS_FILE = prevEnv;
  });

  async function seed(): Promise<void> {
    await writeCheckins(checkinsFile(), [
      checkin({ id: "a", question: "Following up — you'd call the DENTIST. How did it go?", sourceKey: "a" }),
      checkin({ id: "b", question: "Following up — you'd email Bob. How did it go?", sourceKey: "b" })
    ]);
  }

  it("keeps only check-ins whose question matches (case-insensitive), dropping the rest", async () => {
    await seed();
    const r = await runCheckins(["list", "--search", "dentist"]);
    expect(r.stdout).toContain("[a]");
    expect(r.stdout).not.toContain("[b]");
    expect(r.stdout).not.toContain("email Bob");
  });

  it("reflects the filtered count in --json (total is the matched count, not the full set)", async () => {
    await seed();
    const r = await runCheckins(["list", "--search", "dentist", "--json"]);
    const payload = JSON.parse(r.stdout);
    expect(payload.checkins.map((c: PersistedCheckin) => c.id)).toEqual(["a"]);
    expect(payload.total).toBe(1);
  });

  it("absent --search lists everything (no filtering)", async () => {
    await seed();
    const r = await runCheckins(["list", "--status", "all", "--json"]);
    const payload = JSON.parse(r.stdout);
    expect(payload.total).toBe(2);
  });
});

describe("checkins list — ordered by due date, soonest first (sibling parity with followup)", () => {
  const prevEnv = process.env.MUSE_CHECKINS_FILE;
  beforeEach(() => {
    process.env.MUSE_CHECKINS_FILE = join(mkdtempSync(join(tmpdir(), "muse-checkins-")), "checkins.json");
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_CHECKINS_FILE;
    else process.env.MUSE_CHECKINS_FILE = prevEnv;
  });

  it("returns check-ins sorted by dueAtIso ascending, regardless of stored order", async () => {
    await writeCheckins(checkinsFile(), [
      checkin({ id: "late", dueAtIso: "2026-09-01T00:00:00.000Z", sourceKey: "late" }),
      checkin({ id: "early", dueAtIso: "2026-07-01T00:00:00.000Z", sourceKey: "early" }),
      checkin({ id: "mid", dueAtIso: "2026-08-01T00:00:00.000Z", sourceKey: "mid" })
    ]);
    const r = await runCheckins(["list", "--status", "all", "--json"]);
    const payload = JSON.parse(r.stdout);
    expect(payload.checkins.map((c: PersistedCheckin) => c.id)).toEqual(["early", "mid", "late"]);
  });
});

describe("checkins scan — numeric option validation (parity with calendar/feeds/today)", () => {
  const prevEnv = process.env.MUSE_CHECKINS_FILE;
  beforeEach(() => {
    process.env.MUSE_CHECKINS_FILE = join(mkdtempSync(join(tmpdir(), "muse-checkins-")), "checkins.json");
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_CHECKINS_FILE;
    else process.env.MUSE_CHECKINS_FILE = prevEnv;
  });

  it("rejects a non-numeric --slot-hour with exit 1, not a silent NaN hour", async () => {
    const r = await runCheckins(["scan", "--slot-hour", "abc"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--slot-hour must be an integer hour in [0, 23]");
  });

  it("rejects an out-of-range --slot-hour (25)", async () => {
    const r = await runCheckins(["scan", "--slot-hour", "25"]);
    expect(r.exitCode).toBe(1);
  });

  it("rejects --max-per-day below 1", async () => {
    const r = await runCheckins(["scan", "--max-per-day", "0"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--max-per-day must be a positive integer");
  });

  it("accepts a valid --slot-hour without a validation error", async () => {
    const r = await runCheckins(["scan", "--slot-hour", "9"]);
    expect(r.stderr).not.toContain("--slot-hour must be");
  });
});

describe("checkinsFile", () => {
  it("honours MUSE_CHECKINS_FILE, else defaults under ~/.muse/checkins.json", () => {
    expect(checkinsFile({ MUSE_CHECKINS_FILE: "/tmp/c.json" } as NodeJS.ProcessEnv)).toBe("/tmp/c.json");
    expect(checkinsFile({} as NodeJS.ProcessEnv).endsWith("/.muse/checkins.json")).toBe(true);
  });
});

// Deterministic embedder for the discharge filter (no Ollama): "email/bob/report"
// share an axis so an "emailed Bob" discharge matches the "email Bob" commitment.
function fakeEmbed(text: string): Promise<readonly number[]> {
  const t = text.toLowerCase();
  return Promise.resolve([/email|bob|report/.test(t) ? 1 : 0, /call|dentist/.test(t) ? 1 : 0, 0]);
}

describe("scanSessionCheckins — session-end auto-scan (detect → schedule → persist)", () => {
  it("schedules a check-in for a voiced commitment; a no-commitment session schedules none", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-autoscan-")), "checkins.json");
    const withCommitment = await scanSessionCheckins({
      embed: fakeEmbed,
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
      embed: fakeEmbed,
      file,
      userId: "stark",
      now: () => new Date("2026-05-01T09:05:00Z"),
      readHistory: async () => [{ role: "user", content: "what time is it?" }]
    });
    expect(noCommitment).toEqual([]);
  });

  it("does NOT schedule a check-in for a commitment the user discharged later in the session (π-Bench arXiv:2605.14678)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-discharge-")), "checkins.json");
    const fresh = await scanSessionCheckins({
      embed: fakeEmbed,
      file,
      userId: "stark",
      now: () => new Date("2026-05-01T09:00:00Z"),
      readHistory: async () => [
        { role: "user", content: "I need to email Bob about the Q3 report" },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "done — I emailed Bob the Q3 report just now" }
      ]
    });
    // Discharged in-conversation → no nagging check-in. Neutralizing
    // selectOpenCommitments would schedule 1 (the revert-proof).
    expect(fresh).toEqual([]);
    expect(await readCheckins(file)).toEqual([]);
  });
});
