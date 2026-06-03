import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendActionLog } from "@muse/mcp";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { composeEveningRecap, registerRecapCommand, type EveningRecapInput } from "./commands-recap.js";
import type { ProgramIO } from "./program.js";

describe("composeEveningRecap — deterministic evening digest", () => {
  const base = (over: Partial<EveningRecapInput> = {}): EveningRecapInput => ({
    comingUp: [], now: new Date("2026-06-04T21:00:00"), openFollowups: 0, performedToday: [], sessionsToday: 0, ...over
  });

  it("renders the retrospective (actions + sessions), what's coming up, and open follow-ups", () => {
    const out = composeEveningRecap(base({
      comingUp: ["Call the dentist — due 9:00 AM"],
      openFollowups: 3,
      performedToday: ["Sent the standup notes via Telegram", "Locked the front door"],
      sessionsToday: 2
    }));
    expect(out).toContain("Evening recap");
    expect(out).toContain("Today you got done (2)");
    expect(out).toContain("✓ Sent the standup notes via Telegram");
    expect(out).toContain("2 sessions with Muse today");
    expect(out).toContain("Coming up");
    expect(out).toContain("Call the dentist");
    expect(out).toContain("3 open follow-ups");
  });

  it("a quiet day with nothing logged says so (no false 'you got done')", () => {
    const out = composeEveningRecap(base());
    expect(out).toContain("Quiet day — nothing logged yet");
    expect(out).not.toContain("got done");
  });

  it("caps the action list at 8 and notes the overflow", () => {
    const out = composeEveningRecap(base({ performedToday: Array.from({ length: 11 }, (_, i) => `action ${i.toString()}`) }));
    expect(out).toContain("Today you got done (11)");
    expect(out).toContain("…and 3 more");
  });
});

describe("muse recap — wired command over the real stores (fail-soft)", () => {
  const prev = { ...process.env };
  afterEach(() => { process.env = { ...prev }; });

  async function run(): Promise<string> {
    const out: string[] = [];
    const io: ProgramIO = { stderr: (m: string) => out.push(m), stdout: (m: string) => out.push(m) };
    const program = new Command();
    program.exitOverride();
    registerRecapCommand(program, io);
    await program.parseAsync(["node", "muse", "recap"]);
    return out.join("");
  }

  it("surfaces a performed action from today's action log in the digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-recap-"));
    process.env.MUSE_ACTION_LOG_FILE = join(dir, "action-log.json");
    process.env.MUSE_EPISODES_FILE = join(dir, "episodes.json");
    process.env.MUSE_REMINDERS_FILE = join(dir, "reminders.json");
    process.env.MUSE_FOLLOWUPS_FILE = join(dir, "followups.json");
    await appendActionLog(process.env.MUSE_ACTION_LOG_FILE, {
      detail: "",
      id: "a1",
      result: "performed",
      userId: "u",
      what: "Booked the Q3 review room",
      when: new Date().toISOString(),
      why: "objective"
    });
    const out = await run();
    expect(out).toContain("Evening recap");
    expect(out).toContain("✓ Booked the Q3 review room");
  });
});
