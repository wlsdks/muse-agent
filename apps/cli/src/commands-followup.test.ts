import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@muse/shared";

import { readFollowupsStrict, writeFollowups, type PersistedFollowup } from "@muse/stores";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { registerFollowupCommands } from "./commands-followup.js";

async function runFollowup(args: string[]): Promise<{ readonly error?: string; readonly stdout: string }> {
  const stdout: string[] = [];
  const io = { stderr: () => {}, stdout: (m: string) => stdout.push(m) };
  let error: string | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerFollowupCommands(program, io);
    await program.parseAsync(["node", "muse", "followup", ...args]);
  } catch (cause) {
    error = errorMessage(cause);
  }
  return { error, stdout: stdout.join("") };
}

describe("muse followup list — ordering by parsed instant, not lexicographic scheduledFor", () => {
  const prevEnv = process.env.MUSE_FOLLOWUPS_FILE;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_FOLLOWUPS_FILE;
    else process.env.MUSE_FOLLOWUPS_FILE = prevEnv;
  });
  function followup(overrides: Partial<PersistedFollowup>): PersistedFollowup {
    return {
      createdAt: "2026-05-22T00:00:00.000Z",
      id: "f",
      scheduledFor: "2026-05-22T12:00:00.000Z",
      status: "scheduled",
      summary: "x",
      userId: "stark",
      ...overrides
    };
  }

  it("lists a timezone-offset scheduledFor in real-instant order (a lexicographic sort would invert it)", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "muse-followup-list-")), "followups.json");
    // a: 2026-05-22T23:00:00-05:00 == 2026-05-23T04:00:00Z (LATER instant)
    // b: 2026-05-23T01:00:00Z (EARLIER instant)
    // Lexicographically "2026-05-22T23…" < "2026-05-23T01…" → a sorts first; by instant b is first.
    await writeFollowups(f, [
      followup({ id: "a", scheduledFor: "2026-05-22T23:00:00-05:00", summary: "later" }),
      followup({ id: "b", scheduledFor: "2026-05-23T01:00:00Z", summary: "earlier" })
    ]);
    process.env.MUSE_FOLLOWUPS_FILE = f;
    const r = await runFollowup(["list", "--json"]);
    expect(r.error).toBeUndefined();
    const payload = JSON.parse(r.stdout) as { followups: { id: string }[] };
    expect(payload.followups.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});

async function runFollowupCapturing(
  args: string[]
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prevExit = process.exitCode;
  process.exitCode = 0;
  try {
    const program = new Command();
    program.exitOverride();
    registerFollowupCommands(program, io);
    await program.parseAsync(["node", "muse", "followup", ...args]);
  } finally { /* leave exitCode for the caller to read */ }
  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = prevExit;
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

describe("muse followup list — strict --status validation (sibling parity with tasks/checkins)", () => {
  const prevEnv = process.env.MUSE_FOLLOWUPS_FILE;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_FOLLOWUPS_FILE;
    else process.env.MUSE_FOLLOWUPS_FILE = prevEnv;
  });
  const followup = (o: Partial<PersistedFollowup>): PersistedFollowup => ({
    createdAt: "2026-05-22T00:00:00.000Z",
    id: "f",
    scheduledFor: "2026-05-22T12:00:00.000Z",
    status: "scheduled",
    summary: "x",
    userId: "stark",
    ...o
  });

  it("rejects a typo'd --status with exit 1 + did-you-mean, not a silent scheduled list", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "muse-followup-status-")), "followups.json");
    await writeFollowups(f, [
      followup({ id: "s1", status: "scheduled", summary: "sched" }),
      followup({ id: "x1", status: "fired", firedAt: "2026-05-22T13:00:00.000Z", summary: "fired-one" })
    ]);
    process.env.MUSE_FOLLOWUPS_FILE = f;
    const r = await runFollowupCapturing(["list", "--status", "fierd"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--status must be one of: scheduled, fired, cancelled, all");
    expect(r.stderr).toContain("did you mean 'fired'");
    expect(r.stdout).toBe("");
  });

  it("accepts a valid --status without erroring", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "muse-followup-status-ok-")), "followups.json");
    await writeFollowups(f, [followup({ id: "x1", status: "fired", firedAt: "2026-05-22T13:00:00.000Z" })]);
    process.env.MUSE_FOLLOWUPS_FILE = f;
    const r = await runFollowupCapturing(["list", "--status", "fired"]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toBe("");
  });
});

describe("muse followup list --search — filter by summary (sibling parity with tasks/remind/contacts)", () => {
  const prevEnv = process.env.MUSE_FOLLOWUPS_FILE;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_FOLLOWUPS_FILE;
    else process.env.MUSE_FOLLOWUPS_FILE = prevEnv;
  });
  const followup = (o: Partial<PersistedFollowup>): PersistedFollowup => ({
    createdAt: "2026-05-22T00:00:00.000Z",
    id: "f",
    scheduledFor: "2026-05-22T12:00:00.000Z",
    status: "scheduled",
    summary: "x",
    userId: "stark",
    ...o
  });

  it("narrows to followups whose summary matches, case-insensitive", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "muse-followup-search-")), "followups.json");
    process.env.MUSE_FOLLOWUPS_FILE = f;
    await writeFollowups(f, [
      followup({ id: "a", summary: "check Q3 budget memo" }),
      followup({ id: "b", summary: "ping Dana about lunch" })
    ]);
    const r = await runFollowup(["list", "--search", "BUDGET", "--json"]);
    expect(r.error).toBeUndefined();
    const payload = JSON.parse(r.stdout) as { followups: { id: string }[]; total: number };
    expect(payload.followups.map((e) => e.id)).toEqual(["a"]);
    expect(payload.total).toBe(1);
  });
});

describe("muse followup triage preview — exact local and non-mutating", () => {
  const prevEnv = process.env.MUSE_FOLLOWUPS_FILE;
  const prevTriageEnv = process.env.MUSE_FOLLOWUP_TRIAGE_FILE;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_FOLLOWUPS_FILE;
    else process.env.MUSE_FOLLOWUPS_FILE = prevEnv;
    if (prevTriageEnv === undefined) delete process.env.MUSE_FOLLOWUP_TRIAGE_FILE;
    else process.env.MUSE_FOLLOWUP_TRIAGE_FILE = prevTriageEnv;
  });

  it("requires --local and exposes exact canonical before/after JSON without changing the store", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-followup-triage-cli-")), "followups.json");
    process.env.MUSE_FOLLOWUPS_FILE = file;
    process.env.MUSE_FOLLOWUP_TRIAGE_FILE = `${file}.triage`;
    const item: PersistedFollowup = {
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "fu_exact",
      scheduledFor: "2026-02-01T00:00:00.000Z",
      status: "scheduled",
      summary: "private follow-up",
      userId: "owner"
    };
    await writeFollowups(file, [item]);
    const before = await (await import("node:fs/promises")).readFile(file, "utf8");

    const rejected = await runFollowup(["triage", "preview", "dismiss", "fu_exact"]);
    expect(rejected.error).toContain("required option '--local'");

    const result = await runFollowup(["triage", "preview", "dismiss", "fu_exact", "--local", "--json"]);
    expect(result.error).toBeUndefined();
    const preview = JSON.parse(result.stdout) as {
      changes: readonly { before: PersistedFollowup; after: PersistedFollowup }[];
      confirmToken: string;
      operationId: string;
      schemaVersion: string;
      sourceDigest: string;
    };
    expect(preview.schemaVersion).toBe("muse.followup-triage-preview/v1");
    expect(preview.sourceDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(preview.changes).toEqual([{
      after: { ...item, cancelReason: "backlog-triage-dismissed", status: "cancelled" },
      before: item
    }]);
    expect(await (await import("node:fs/promises")).readFile(file, "utf8")).toBe(before);

    const missingLocal = await runFollowup(["triage", "confirm", preview.confirmToken, "--json"]);
    expect(missingLocal.error).toContain("required option '--local'");
    const confirmed = await runFollowup(["triage", "confirm", preview.confirmToken, "--local", "--json"]);
    expect(confirmed.error).toBeUndefined();
    expect(JSON.parse(confirmed.stdout)).toMatchObject({
      action: "dismiss",
      operationId: preview.operationId,
      outcome: "applied",
      status: "applied"
    });
    expect((await readFollowupsStrict(file))[0]?.status).toBe("cancelled");
    const replay = await runFollowup(["triage", "confirm", preview.confirmToken, "--local", "--json"]);
    expect(replay.stdout).toBe(confirmed.stdout);
  });

  it("renders owner-visible exact snooze state and keeps draft-digest local", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-followup-triage-text-")), "followups.json");
    process.env.MUSE_FOLLOWUPS_FILE = file;
    process.env.MUSE_FOLLOWUP_TRIAGE_FILE = `${file}.triage`;
    await writeFollowups(file, [{
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "fu_text",
      scheduledFor: "2026-02-01T00:00:00.000Z",
      status: "scheduled",
      summary: "line one\nline two",
      userId: "owner"
    }]);

    const snooze = await runFollowup([
      "triage", "preview", "snooze", "fu_text", "--local", "--snooze-at", "2099-01-01T09:00:00+09:00"
    ]);
    expect(snooze.error).toBeUndefined();
    expect(snooze.stdout).toContain('"scheduledFor":"2099-01-01T00:00:00.000Z"');

    const draft = await runFollowup(["triage", "preview", "draft-digest", "fu_text", "--local", "--json"]);
    expect(draft.error).toBeUndefined();
    expect((JSON.parse(draft.stdout) as { digestDraft: string }).digestDraft).toContain("line one line two");
  });
});
