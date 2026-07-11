import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendActionLog, type ActionLogEntry } from "@muse/stores";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerActionsCommands } from "./commands-actions.js";

async function run(file: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prev = process.env.MUSE_ACTION_LOG_FILE;
  process.env.MUSE_ACTION_LOG_FILE = file;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerActionsCommands(program, io);
    await program.parseAsync(["node", "muse", "actions", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    if (prev === undefined) delete process.env.MUSE_ACTION_LOG_FILE;
    else process.env.MUSE_ACTION_LOG_FILE = prev;
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-cli-actions-")), "action-log.json");
}

function entry(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    id: "a1",
    objectiveId: "obj_ship",
    result: "performed",
    userId: "local",
    what: "objective met — user notified",
    when: "2026-05-19T12:00:00.000Z",
    why: "ship the release",
    ...overrides
  };
}

describe("muse actions — the accountability read surface", () => {
  it("lists recorded autonomous actions newest-first with rationale", async () => {
    const file = logFile();
    await appendActionLog(file, entry({ id: "old", when: "2026-05-19T10:00:00.000Z" }));
    await appendActionLog(file, entry({ id: "new", when: "2026-05-19T14:00:00.000Z", why: "newer" }));
    const r = await run(file, []);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout.indexOf("newer")).toBeLessThan(r.stdout.indexOf("ship the release"));
    expect(r.stdout).toContain("[performed]  objective met — user notified (obj_ship) — newer");
  });

  it("empty log → friendly message, not an error", async () => {
    expect((await run(logFile(), [])).stdout).toBe("No recorded actions.\n");
  });

  it("empty default bucket but entries under another bucket → points at --user all (so channel-triggered actions aren't invisible)", async () => {
    const file = logFile();
    await appendActionLog(file, entry({ id: "tg", result: "refused", userId: "telegram:42", what: "blocked email_send" }));
    const r = await run(file, []); // default --user local, which has nothing
    expect(r.stdout).toContain("No recorded actions for 'local'");
    expect(r.stdout).toContain("telegram:42");
    expect(r.stdout).toContain("--user all");
    // and --user all surfaces it
    expect((await run(file, ["--user", "all"])).stdout).toContain("blocked email_send");
  });

  it("does NOT mis-suggest --user all when the bucket has entries but a --result filter empties the view", async () => {
    const file = logFile();
    await appendActionLog(file, entry({ id: "p", result: "performed", userId: "local" }));
    const r = await run(file, ["--result", "refused"]); // local has a performed entry, just none refused
    expect(r.stdout).toBe("No recorded actions.\n");
  });

  it("--result filters and --user scopes (default 'local'); 'all' shows every bucket", async () => {
    const file = logFile();
    await appendActionLog(file, entry({ id: "p", result: "performed", userId: "local" }));
    await appendActionLog(file, entry({ id: "r", result: "refused", userId: "local", what: "blocked X" }));
    await appendActionLog(file, entry({ id: "o", result: "performed", userId: "stark", what: "stark thing" }));
    expect((await run(file, ["--result", "refused"])).stdout).toContain("blocked X");
    expect((await run(file, ["--result", "refused"])).stdout).not.toContain("objective met");
    expect((await run(file, [])).stdout).not.toContain("stark thing");
    expect((await run(file, ["--user", "all"])).stdout).toContain("stark thing");
  });

  it("--limit caps the newest-first slice", async () => {
    const file = logFile();
    for (let i = 0; i < 5; i += 1) {
      await appendActionLog(file, entry({ id: `e${i}`, when: `2026-05-19T1${i}:00:00.000Z`, why: `w${i}` }));
    }
    const r = await run(file, ["--limit", "2"]);
    expect(r.stdout.split("\n").filter((l) => l.length > 0)).toHaveLength(2);
    expect(r.stdout).toContain("w4");
    expect(r.stdout).not.toContain("w0");
  });

  it("rejects an unknown --result with a hint, and a non-positive --limit", async () => {
    const f = logFile();
    const r1 = await run(f, ["--result", "perfomed"]);
    expect(r1.exitCode).toBe(1);
    expect(r1.stderr).toContain("--result must be one of");
    expect(r1.stderr).toContain("did you mean 'performed'");
    const r2 = await run(f, ["--limit", "0"]);
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toContain("--limit must be a positive integer");
  });

  it("rejects a typo / unit-slipped --limit instead of silently accepting the digit prefix", async () => {
    const f = logFile();
    for (const bad of ["20x", "5min", "10 entries", "-3", "1.5"]) {
      const r = await run(f, ["--limit", bad]);
      expect(r.exitCode, `${bad} must fail`).toBe(1);
      expect(r.stderr, `${bad} should mention the bad value`).toContain(`'${bad}'`);
      expect(r.stderr).toContain("--limit must be a positive integer");
    }
  });

  it("--json emits a machine-readable envelope { entries, result, total, user } — empty log returns total=0 + empty entries (not the friendly stdout message)", async () => {
    const empty = logFile();
    const r1 = await run(empty, ["--json"]);
    expect(r1.exitCode).toBeUndefined();
    expect(r1.stdout, "json mode must NOT emit the human-readable empty-state line").not.toContain("No recorded actions.");
    const parsedEmpty = JSON.parse(r1.stdout) as { entries: unknown[]; result: string; total: number; user: string };
    expect(parsedEmpty.entries).toEqual([]);
    expect(parsedEmpty.total).toBe(0);
    expect(parsedEmpty.result).toBe("all");
    expect(parsedEmpty.user).toBe("local");

    const file = logFile();
    await appendActionLog(file, entry({ id: "old", when: "2026-05-19T10:00:00.000Z" }));
    await appendActionLog(file, entry({ id: "new", when: "2026-05-19T14:00:00.000Z", why: "newer" }));
    const r2 = await run(file, ["--json"]);
    expect(r2.exitCode).toBeUndefined();
    const parsed = JSON.parse(r2.stdout) as { entries: Array<{ id: string; why: string; objectiveId?: string }>; total: number; result: string; user: string };
    expect(parsed.total).toBe(2);
    expect(parsed.entries.map((e) => e.id), "entries come back newest-first via queryActionLog").toEqual(["new", "old"]);
    expect(parsed.entries[0]?.why).toBe("newer");
    expect(parsed.entries[0]?.objectiveId).toBe("obj_ship");

    const r3 = await run(file, ["--json", "--limit", "1", "--result", "performed"]);
    const parsed3 = JSON.parse(r3.stdout) as { entries: Array<{ id: string }>; total: number; result: string };
    expect(parsed3.total).toBe(1);
    expect(parsed3.result).toBe("performed");
    expect(parsed3.entries[0]?.id).toBe("new");
  });

  it("--user '   ' falls back to the same 'local' bucket as the default — does NOT leak other buckets via the empty-string fallthrough on queryActionLog's truthy filter", async () => {
    const file = logFile();
    await appendActionLog(file, entry({ id: "local-1", userId: "local", what: "local entry" }));
    await appendActionLog(file, entry({ id: "stark-1", userId: "stark", what: "stark entry" }));
    const r = await run(file, ["--user", "   "]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout, "whitespace --user must resolve to 'local' (matching the default), not leak other buckets").toContain("local entry");
    expect(r.stdout).not.toContain("stark entry");
  });
});

describe("muse actions --verify — the tamper-evidence integrity check", () => {
  it("a freshly-appended log verifies as chain intact", async () => {
    const file = logFile();
    await appendActionLog(file, entry({ id: "a0", when: "2026-05-19T10:00:00.000Z" }));
    await appendActionLog(file, entry({ id: "a1", when: "2026-05-19T11:00:00.000Z" }));
    const r = await run(file, ["--verify"]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain("chain intact");
    expect(r.stdout).toContain("2 linked");
  });

  it("a byte-flipped historical entry on disk fails the check, exits 1, and names the broken index", async () => {
    const file = logFile();
    for (let i = 0; i < 3; i += 1) {
      await appendActionLog(file, entry({ id: `a${i.toString()}`, when: `2026-05-19T1${i.toString()}:00:00.000Z` }));
    }
    // Tamper directly on disk: rewrite entry 0's `what`, leaving its prevHash —
    // the chain must catch it at entry 1.
    const raw = JSON.parse(readFileSync(file, "utf8")) as { entries: ActionLogEntry[] };
    raw.entries[0] = { ...raw.entries[0]!, what: "COVERED UP" };
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const r = await run(file, ["--verify"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("TAMPERING DETECTED at entry 1");
  });

  it("--verify --json emits the structured verdict", async () => {
    const file = logFile();
    await appendActionLog(file, entry({ id: "a0" }));
    const r = await run(file, ["--verify", "--json"]);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; linkedEntries: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.linkedEntries).toBe(1);
  });
});
