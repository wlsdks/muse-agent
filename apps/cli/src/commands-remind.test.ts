import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readReminders, writeReminders, type PersistedReminder } from "@muse/mcp";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { filterRemindersBySearch, formatReminderList, registerRemindCommands, resolveLocalReminderId, type RemindCommandHelpers } from "./commands-remind.js";

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
  readonly stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const apiCalls: ApiCall[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
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
  return { apiCalls, error, stderr: stderr.join(""), stdout: stdout.join("") };
}

describe("muse remind add — past-time guard (a date typo would fire immediately)", () => {
  // --local resolves the reminders file from MUSE_REMINDERS_FILE; without this
  // isolation these add tests wrote 'old'/'future' fixtures into the REAL
  // ~/.muse/reminders.json on every run (1227 junk reminders had accumulated).
  const prevEnv = process.env.MUSE_REMINDERS_FILE;
  beforeEach(() => {
    process.env.MUSE_REMINDERS_FILE = join(mkdtempSync(join(tmpdir(), "muse-rem-past-")), "reminders.json");
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_REMINDERS_FILE;
    else process.env.MUSE_REMINDERS_FILE = prevEnv;
  });

  it("warns when the resolved dueAt is in the PAST, but still adds it (warn, don't block)", async () => {
    const r = await runRemind(["2020-01-01T09:00:00Z", "old", "--local"]);
    expect(r.error).toBeUndefined();
    expect(r.stderr).toContain("in the PAST");
    expect(r.stderr).toContain("overdue");
    expect(r.stdout).toContain("Added"); // not blocked — the reminder is still created
  });

  it("does NOT warn for a future time", async () => {
    const r = await runRemind(["2099-01-01T09:00:00Z", "future", "--local"]);
    expect(r.stderr).not.toContain("PAST");
    expect(r.stdout).toContain("Added");
  });

  it("emits no prose past-warning under --json (structured output stays clean)", async () => {
    const r = await runRemind(["2020-01-01T09:00:00Z", "old", "--local", "--json"]);
    expect(r.stderr).not.toContain("PAST");
  });
});

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
    expect(r.error).toContain("--repeat must be 'daily', 'weekly', 'monthly', or 'yearly'");
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

describe("resolveLocalReminderId — by TEXT (CLI parity with the agent's by-name reminder tools)", () => {
  const reminders = [
    { id: "rem_abc123def", text: "Pay the rent", dueAt: "2026-05-21T10:00:00Z", createdAt: "2026-05-20T10:00:00Z", status: "pending" as const },
    { id: "rem_xyz789ghi", text: "Call the dentist", dueAt: "2026-05-21T11:00:00Z", createdAt: "2026-05-20T10:00:00Z", status: "pending" as const }
  ];

  it("resolves a reminder by a case-insensitive text substring (no uuid needed)", () => {
    expect(resolveLocalReminderId("rent", reminders)).toBe("rem_abc123def");
    expect(resolveLocalReminderId("DENTIST", reminders)).toBe("rem_xyz789ghi");
  });

  it("rejects an ambiguous text with the candidate texts, never guessing", () => {
    const two = [
      { id: "rem_a", text: "review the budget", dueAt: "2026-05-21T10:00:00Z", createdAt: "2026-05-20T10:00:00Z", status: "pending" as const },
      { id: "rem_b", text: "review the roadmap", dueAt: "2026-05-21T11:00:00Z", createdAt: "2026-05-20T10:00:00Z", status: "pending" as const }
    ];
    expect(() => resolveLocalReminderId("review", two))
      .toThrow(/'review' matches 2 reminders: 'review the budget', 'review the roadmap'/u);
  });

  it("prefers a PENDING reminder over a fired one when both texts match", () => {
    const mixed = [
      { id: "rem_fired", text: "pay rent", dueAt: "2026-05-18T10:00:00Z", createdAt: "2026-05-17T10:00:00Z", status: "fired" as const },
      { id: "rem_pending", text: "pay rent", dueAt: "2026-06-21T10:00:00Z", createdAt: "2026-05-20T10:00:00Z", status: "pending" as const }
    ];
    expect(resolveLocalReminderId("pay rent", mixed)).toBe("rem_pending");
  });

  it("still throws not-found when neither id nor text matches", () => {
    expect(() => resolveLocalReminderId("nonexistent", reminders)).toThrow(/reminder not found: nonexistent/u);
  });
});

describe("muse remind list --search — text filter (sibling parity with `tasks list`)", () => {
  const reminder = (o: Partial<PersistedReminder>): PersistedReminder => ({
    createdAt: "2026-05-20T00:00:00.000Z",
    dueAt: "2026-05-21T10:00:00Z",
    id: "r",
    status: "pending",
    text: "x",
    ...o
  });
  const prevEnv = process.env.MUSE_REMINDERS_FILE;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_REMINDERS_FILE;
    else process.env.MUSE_REMINDERS_FILE = prevEnv;
  });

  it("narrows the list to reminders whose text matches, case-insensitive", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "muse-rem-search-")), "reminders.json");
    process.env.MUSE_REMINDERS_FILE = f;
    await writeReminders(f, [
      reminder({ id: "a", text: "Call the dentist" }),
      reminder({ id: "b", text: "buy milk" })
    ]);
    const r = await runRemind(["list", "--local", "--json", "--search", "DENTIST"]);
    expect(r.error).toBeUndefined();
    const payload = JSON.parse(r.stdout) as { reminders: { text: string }[]; total: number };
    expect(payload.reminders).toHaveLength(1);
    expect(payload.reminders[0]!.text).toBe("Call the dentist");
    expect(payload.total).toBe(1);
  });
});

describe("filterRemindersBySearch", () => {
  it("matches text case-insensitively and returns all on a blank query", () => {
    const rems = [{ text: "Alpha" }, { text: "beta" }];
    expect(filterRemindersBySearch(rems, "ALPHA")).toHaveLength(1);
    expect(filterRemindersBySearch(rems, "   ")).toHaveLength(2);
  });
});

describe("formatReminderList — overdue pending reminders are flagged", () => {
  const NOW = new Date("2026-06-22T00:00:00Z").getTime();
  const mk = (over: Record<string, unknown>) => ({ status: "pending", total: 1, reminders: [over] });

  it("marks a pending reminder whose dueAt has passed with (⚠ overdue)", () => {
    const out = formatReminderList(mk({ id: "rem_aaaaaaaa", dueAt: "2026-06-06T12:31:00Z", text: "알람", status: "pending" }), NOW);
    expect(out).toContain("알람 (⚠ overdue)");
  });

  it("does NOT flag a future pending reminder", () => {
    const out = formatReminderList(mk({ id: "rem_bbbbbbbb", dueAt: "2026-07-01T09:00:00Z", text: "약 먹기", status: "pending" }), NOW);
    expect(out).toContain("약 먹기");
    expect(out).not.toContain("overdue");
  });

  it("does NOT flag a fired reminder even if its dueAt is past (it already fired)", () => {
    const out = formatReminderList(mk({ id: "rem_cccccccc", dueAt: "2026-06-06T12:31:00Z", text: "운동", status: "fired" }), NOW);
    expect(out).toContain("(fired)");
    expect(out).not.toContain("overdue");
  });
});
