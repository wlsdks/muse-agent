import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readReminders, writeReminders, type PersistedReminder } from "@muse/mcp";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { registerRemindCommands, resolveLocalReminderId, type RemindCommandHelpers } from "./commands-remind.js";

interface ApiCall {
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly method?: string;
}

async function runRemind(
  args: string[],
  apiRequestOverride?: RemindCommandHelpers["apiRequest"]
): Promise<{
  readonly error?: string;
  readonly apiCalls: readonly ApiCall[];
  readonly stdout: string;
}> {
  const stdout: string[] = [];
  const apiCalls: ApiCall[] = [];
  const io = { stderr: () => {}, stdout: (m: string) => stdout.push(m) };
  const helpers: RemindCommandHelpers = {
    apiRequest: apiRequestOverride ?? (async (_io, _command, path, body, method) => {
      apiCalls.push({ body, method, path });
      return { dueAt: String(body?.dueAt ?? ""), id: "rem_remote", text: String(body?.text ?? "") };
    }),
    writeOutput: (wio, value) => wio.stdout(`${JSON.stringify(value)}\n`)
  };
  let error: string | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerRemindCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "remind", ...args]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return { apiCalls, error, stdout: stdout.join("") };
}

describe("muse remind add — pre-dispatch <when> validation", () => {
  it("remote mode rejects an invalid <when> with the actionable error BEFORE any API call", async () => {
    const r = await runRemind(["blah-not-a-time", "buy", "milk"]);
    expect(r.error).toBeDefined();
    expect(r.error).toContain("ISO-8601");
    expect(r.error).toContain("relative phrase");
    // The whole point: no wasted round-trip on input the server
    // (same parseReminderDueAt grammar) would only reject anyway.
    expect(r.apiCalls).toHaveLength(0);
  });

  it("remote mode still sends a VALID <when> raw to the API (server stays the resolution authority)", async () => {
    const r = await runRemind(["in 3 hours", "stand", "up"]);
    expect(r.error).toBeUndefined();
    expect(r.apiCalls).toHaveLength(1);
    expect(r.apiCalls[0]!.path).toBe("/api/reminders");
    expect(r.apiCalls[0]!.body).toMatchObject({ dueAt: "in 3 hours", text: "stand up" });
  });

  it("local mode keeps rejecting an invalid <when> with the same actionable error", async () => {
    const r = await runRemind(["--local", "still-not-a-time", "do", "thing"]);
    expect(r.error).toBeDefined();
    expect(r.error).toContain("relative phrase");
    expect(r.apiCalls).toHaveLength(0);
  });
});

describe("muse remind — API-unreachable falls back to the local store (local-first reliability)", () => {
  const prevEnv = process.env.MUSE_REMINDERS_FILE;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_REMINDERS_FILE;
    else process.env.MUSE_REMINDERS_FILE = prevEnv;
  });

  const unreachable: RemindCommandHelpers["apiRequest"] = async () => {
    throw new Error("muse: Muse API not reachable at http://127.0.0.1:3030");
  };

  it("add: an unreachable API writes the reminder LOCALLY instead of hard-erroring", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "muse-rem-fb-")), "reminders.json");
    process.env.MUSE_REMINDERS_FILE = f;
    const r = await runRemind(["tomorrow at 9am", "call the dentist"], unreachable);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain("Added");
    const stored = await readReminders(f);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: "pending", text: "call the dentist" });
  });

  it("add: a REAL api error (NOT unreachable) still throws — the fallback never masks a 500", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "muse-rem-fb-err-")), "reminders.json");
    process.env.MUSE_REMINDERS_FILE = f;
    const serverError: RemindCommandHelpers["apiRequest"] = async () => {
      throw new Error("HTTP 500 internal server error");
    };
    const r = await runRemind(["tomorrow at 9am", "call the dentist"], serverError);
    expect(r.error).toBeDefined();
    expect(r.error).toContain("500");
    expect(await readReminders(f)).toHaveLength(0); // not silently written locally on a real error
  });

  it("clear: an unreachable API removes the reminder from the LOCAL store", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "muse-rem-fb-clr-")), "reminders.json");
    process.env.MUSE_REMINDERS_FILE = f;
    await runRemind(["--local", "2026-12-25T09:00:00Z", "one-off"]);
    const id = (await readReminders(f))[0]!.id;
    const r = await runRemind(["clear", id], unreachable);
    expect(r.error).toBeUndefined();
    expect(await readReminders(f)).toHaveLength(0);
  });
});

describe("muse remind add --repeat — recurring reminders", () => {
  const prevEnv = process.env.MUSE_REMINDERS_FILE;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_REMINDERS_FILE;
    else process.env.MUSE_REMINDERS_FILE = prevEnv;
  });

  it("remote mode sends recurrence in the POST body", async () => {
    const r = await runRemind(["2026-12-25T09:00:00Z", "standup", "--repeat", "weekly"]);
    expect(r.error).toBeUndefined();
    expect(r.apiCalls[0]!.body).toMatchObject({ recurrence: "weekly" });
  });

  it("rejects an invalid --repeat value (no reminder created)", async () => {
    const r = await runRemind(["2026-12-25T09:00:00Z", "standup", "--repeat", "hourly"]);
    expect(r.error).toContain("--repeat must be 'daily' or 'weekly'");
    expect(r.apiCalls).toHaveLength(0);
  });

  it("local mode persists recurrence into the real store", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "muse-rem-rep-")), "reminders.json");
    process.env.MUSE_REMINDERS_FILE = f;
    const r = await runRemind(["--local", "2026-12-25T09:00:00Z", "water the plants", "--repeat", "daily"]);
    expect(r.error).toBeUndefined();
    const stored = await readReminders(f);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ recurrence: "daily", status: "pending", text: "water the plants" });
  });

  it("`list` surfaces that a reminder repeats (not indistinguishable from a one-shot)", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "muse-rem-list-")), "reminders.json");
    process.env.MUSE_REMINDERS_FILE = f;
    await runRemind(["--local", "2026-12-25T09:00:00Z", "standup", "--repeat", "weekly"]);
    await runRemind(["--local", "2026-12-26T09:00:00Z", "one-off errand"]);
    const list = await runRemind(["list", "--local"]);
    expect(list.stdout).toContain("standup (repeats weekly)");
    // a one-shot carries no repeats suffix
    expect(list.stdout).toMatch(/one-off errand(?! \(repeats)/u);
  });
});

describe("muse remind list --local — ordering by parsed instant, not lexicographic dueAt", () => {
  const prevEnv = process.env.MUSE_REMINDERS_FILE;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_REMINDERS_FILE;
    else process.env.MUSE_REMINDERS_FILE = prevEnv;
  });
  function reminder(overrides: Partial<PersistedReminder>): PersistedReminder {
    return { createdAt: "2026-05-22T00:00:00.000Z", dueAt: "2026-05-22T12:00:00.000Z", id: "r", status: "pending", text: "x", ...overrides };
  }

  it("lists a timezone-offset dueAt in real-instant order (a lexicographic sort would invert it)", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "muse-remind-list-")), "reminders.json");
    // a: 2026-05-22T23:00:00-05:00 == 2026-05-23T04:00:00Z (LATER instant)
    // b: 2026-05-23T01:00:00Z (EARLIER instant)
    // Lexicographically "2026-05-22T23…" < "2026-05-23T01…" → a sorts first; by instant b is first.
    await writeReminders(f, [
      reminder({ dueAt: "2026-05-22T23:00:00-05:00", id: "a", text: "later" }),
      reminder({ dueAt: "2026-05-23T01:00:00Z", id: "b", text: "earlier" })
    ]);
    process.env.MUSE_REMINDERS_FILE = f;
    const r = await runRemind(["list", "--local", "--json"]);
    expect(r.error).toBeUndefined();
    const payload = JSON.parse(r.stdout) as { reminders: { id: string }[] };
    expect(payload.reminders.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});

describe("resolveLocalReminderId — typo-tolerant id resolution (goal-544 sibling)", () => {
  const reminders = [
    { id: "rem_abc123def", text: "alpha", dueAt: "2026-05-21T10:00:00Z", createdAt: "2026-05-20T10:00:00Z", status: "pending" as const },
    { id: "rem_xyz789ghi", text: "beta", dueAt: "2026-05-21T11:00:00Z", createdAt: "2026-05-20T10:00:00Z", status: "pending" as const }
  ];

  it("returns the exact id when found", () => {
    expect(resolveLocalReminderId("rem_abc123def", reminders)).toBe("rem_abc123def");
  });

  it("resolves an unambiguous prefix", () => {
    expect(resolveLocalReminderId("rem_abc", reminders)).toBe("rem_abc123def");
  });

  it("rejects an ambiguous prefix with the count + guidance", () => {
    expect(() => resolveLocalReminderId("rem_", reminders))
      .toThrow(/ambiguous reminder prefix 'rem_' matched 2 reminders/u);
  });

  it("suggests the closest existing id on a near-miss typo (one-char swap on the trailing char)", () => {
    expect(() => resolveLocalReminderId("rem_abc123dex", reminders))
      .toThrow(/reminder not found: rem_abc123dex — did you mean 'rem_abc123def'/u);
  });

  it("rejects an unrelated input WITHOUT a guess (no random suggestion noise)", () => {
    expect(() => resolveLocalReminderId("totallyunrelated", reminders))
      .toThrow(/reminder not found: totallyunrelated$/u);
  });
});
