import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { countRunningJobs, JOB_STATUS_FILTER_VALUES, jobsDir, parseJobListLimit, registerJobCommands, resolveJobStatusFilter, startBackgroundJobOrRefuse } from "./commands-jobs.js";

describe("parseJobListLimit", () => {
  it("defaults to 20 when blank", () => {
    expect(parseJobListLimit(undefined)).toBe(20);
    expect(parseJobListLimit("")).toBe(20);
    expect(parseJobListLimit("   ")).toBe(20);
  });

  it("accepts a genuine number, truncating and clamping to 200", () => {
    expect(parseJobListLimit("5")).toBe(5);
    expect(parseJobListLimit(" 12 ")).toBe(12);
    expect(parseJobListLimit("3.9")).toBe(3);
    expect(parseJobListLimit("999")).toBe(200);
  });

  it("rejects a unit slip / non-numeric / non-positive instead of silently using 20", () => {
    expect(() => parseJobListLimit("20x")).toThrow(/--limit must be a positive number \(got '20x'\)/u);
    expect(() => parseJobListLimit("abc")).toThrow(/positive number/u);
    expect(() => parseJobListLimit("0")).toThrow(/positive number/u);
    expect(() => parseJobListLimit("-4")).toThrow(/positive number/u);
  });
});

describe("resolveJobStatusFilter", () => {
  it("returns 'all' when input is undefined or empty/whitespace", () => {
    expect(resolveJobStatusFilter(undefined)).toBe("all");
    expect(resolveJobStatusFilter("")).toBe("all");
    expect(resolveJobStatusFilter("   ")).toBe("all");
  });

  it("normalises case so RUNNING / Done / Error all resolve", () => {
    expect(resolveJobStatusFilter("RUNNING")).toBe("running");
    expect(resolveJobStatusFilter("Done")).toBe("done");
    expect(resolveJobStatusFilter("ERROR")).toBe("error");
  });

  it("returns each known filter value verbatim (lowercased)", () => {
    for (const value of JOB_STATUS_FILTER_VALUES) {
      expect(resolveJobStatusFilter(value)).toBe(value);
    }
  });

  it("returns 'invalid' for unknown values so the caller can render a typo hint", () => {
    expect(resolveJobStatusFilter("runing")).toBe("invalid");
    expect(resolveJobStatusFilter("pending")).toBe("invalid");
    expect(resolveJobStatusFilter("nonsense")).toBe("invalid");
  });

  it("treats surrounding whitespace as a non-issue", () => {
    expect(resolveJobStatusFilter("  done  ")).toBe("done");
  });
});

describe("muse job list --json", () => {
  function seedJob(dir: string, id: string, events: ReadonlyArray<Record<string, unknown>>): void {
    writeFileSync(join(dir, `${id}.jsonl`), events.map((ev) => JSON.stringify(ev)).join("\n"), "utf8");
  }

  async function runJobList(args: readonly string[], jobsDir: string): Promise<{ stdout: string; stderr: string }> {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const io = {
      stdout: (msg: string) => stdoutChunks.push(msg),
      stderr: (msg: string) => stderrChunks.push(msg)
    };
    const previous = process.env.MUSE_JOBS_DIR;
    process.env.MUSE_JOBS_DIR = jobsDir;
    try {
      const program = new Command();
      registerJobCommands(program, io);
      await program.parseAsync(["node", "muse", "job", "list", ...args]);
    } finally {
      if (previous === undefined) delete process.env.MUSE_JOBS_DIR;
      else process.env.MUSE_JOBS_DIR = previous;
    }
    return { stderr: stderrChunks.join(""), stdout: stdoutChunks.join("") };
  }

  it("emits the structured payload with dir / status / matched / jobs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-job-list-json-"));
    seedJob(dir, "job_2026-05-15T10-00-00_done0001", [
      { prompt: "research", tsIso: "2026-05-15T10:00:00Z", type: "started" },
      { tsIso: "2026-05-15T10:01:00Z", type: "done" }
    ]);
    seedJob(dir, "job_2026-05-15T11-00-00_runn0002", [
      { prompt: "draft doc", tsIso: "2026-05-15T11:00:00Z", type: "started" }
    ]);

    const { stdout } = await runJobList(["--json"], dir);
    const payload = JSON.parse(stdout) as {
      dir: string;
      status: string;
      matched: number;
      jobs: ReadonlyArray<{ id: string; status: string; prompt: string }>;
    };
    expect(payload.dir).toBe(dir);
    expect(payload.status).toBe("all");
    expect(payload.matched).toBe(2);
    expect(payload.jobs.map((j) => j.status).sort()).toEqual(["done", "running"]);
  });

  it("honours --status filter inside the JSON payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-job-list-json-filter-"));
    seedJob(dir, "job_2026-05-15T10-00-00_done0001", [
      { prompt: "a", tsIso: "2026-05-15T10:00:00Z", type: "started" },
      { tsIso: "2026-05-15T10:01:00Z", type: "done" }
    ]);
    seedJob(dir, "job_2026-05-15T11-00-00_runn0002", [
      { prompt: "b", tsIso: "2026-05-15T11:00:00Z", type: "started" }
    ]);

    const { stdout } = await runJobList(["--json", "--status", "running"], dir);
    const payload = JSON.parse(stdout) as {
      status: string;
      matched: number;
      jobs: ReadonlyArray<{ id: string; status: string }>;
    };
    expect(payload.status).toBe("running");
    expect(payload.matched).toBe(1);
    expect(payload.jobs[0]?.status).toBe("running");
  });

  it("returns an empty jobs array (not an error) when the dir doesn't exist", async () => {
    const dir = join(tmpdir(), `muse-job-list-missing-${Date.now().toString()}-${Math.random().toString().slice(2)}`);
    const { stdout, stderr } = await runJobList(["--json"], dir);
    expect(stderr).toBe("");
    const payload = JSON.parse(stdout) as { jobs: unknown[]; matched: number };
    expect(payload.jobs).toEqual([]);
    expect(payload.matched).toBe(0);
  });
});

describe("jobsDir — MUSE_JOBS_DIR empty-env-shadow defence (goal-532/539 sibling)", () => {
  it("uses the env value when MUSE_JOBS_DIR is set non-empty", () => {
    const prev = process.env.MUSE_JOBS_DIR;
    process.env.MUSE_JOBS_DIR = "/tmp/custom-jobs";
    try {
      expect(jobsDir()).toBe("/tmp/custom-jobs");
    } finally {
      if (prev === undefined) delete process.env.MUSE_JOBS_DIR;
      else process.env.MUSE_JOBS_DIR = prev;
    }
  });

  it("falls back to ~/.muse/jobs when MUSE_JOBS_DIR is whitespace-only — does NOT return '' that would crash fs ops or write under filesystem root", () => {
    const prev = process.env.MUSE_JOBS_DIR;
    process.env.MUSE_JOBS_DIR = "   ";
    try {
      const path = jobsDir();
      expect(path.replaceAll("\\", "/")).toMatch(/\/\.muse\/jobs$/u);
      expect(path, "whitespace-only env must NOT leak through as the resolved path").not.toBe("");
      expect(path).not.toBe("   ");
    } finally {
      if (prev === undefined) delete process.env.MUSE_JOBS_DIR;
      else process.env.MUSE_JOBS_DIR = prev;
    }
  });
});

describe("countRunningJobs", () => {
  function seed(dir: string, id: string, events: ReadonlyArray<Record<string, unknown>>): void {
    writeFileSync(join(dir, `${id}.jsonl`), events.map((ev) => JSON.stringify(ev)).join("\n"), "utf8");
  }

  it("counts only jobs whose latest event is 'running' (started, no done/error yet)", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-job-count-running-"));
    seed(dir, "job_running_1", [{ prompt: "a", tsIso: "2026-05-15T10:00:00Z", type: "started" }]);
    seed(dir, "job_running_2", [{ prompt: "b", tsIso: "2026-05-15T10:00:00Z", type: "started" }]);
    seed(dir, "job_done_1", [
      { prompt: "c", tsIso: "2026-05-15T10:00:00Z", type: "started" },
      { tsIso: "2026-05-15T10:01:00Z", type: "done" }
    ]);
    seed(dir, "job_error_1", [
      { prompt: "d", tsIso: "2026-05-15T10:00:00Z", type: "started" },
      { text: "boom", tsIso: "2026-05-15T10:01:00Z", type: "error" }
    ]);
    expect(countRunningJobs(dir)).toBe(2);
  });

  it("returns 0 for a dir that doesn't exist yet", () => {
    const dir = join(tmpdir(), `muse-job-count-missing-${Date.now().toString()}`);
    expect(countRunningJobs(dir)).toBe(0);
  });
});

describe("startBackgroundJobOrRefuse", () => {
  function makeIo(): { io: { stdout: (m: string) => void; stderr: (m: string) => void }; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { io: { stderr: (m) => stderr.push(m), stdout: (m) => stdout.push(m) }, stderr, stdout };
  }
  function seed(dir: string, id: string, events: ReadonlyArray<Record<string, unknown>>): void {
    writeFileSync(join(dir, `${id}.jsonl`), events.map((ev) => JSON.stringify(ev)).join("\n"), "utf8");
  }

  it("refuses and does NOT call start when running count is at the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-job-cap-at-"));
    seed(dir, "job_r1", [{ tsIso: "2026-05-15T10:00:00Z", type: "started" }]);
    seed(dir, "job_r2", [{ tsIso: "2026-05-15T10:00:00Z", type: "started" }]);
    seed(dir, "job_r3", [{ tsIso: "2026-05-15T10:00:00Z", type: "started" }]);
    const { io, stderr } = makeIo();
    let calls = 0;
    const result = startBackgroundJobOrRefuse("do a thing", {}, io, {
      env: { MUSE_JOBS_MAX_CONCURRENT: "3" },
      jobsDirPath: dir,
      start: () => { calls += 1; return { file: "x", id: "x" }; }
    });
    expect(result).toBeUndefined();
    expect(calls).toBe(0);
    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toMatch(/limit/iu);
    process.exitCode = 0;
  });

  it("starts the job when running count is under the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-job-cap-under-"));
    seed(dir, "job_r1", [{ tsIso: "2026-05-15T10:00:00Z", type: "started" }]);
    const { io, stderr } = makeIo();
    let calls = 0;
    const result = startBackgroundJobOrRefuse("do a thing", {}, io, {
      env: { MUSE_JOBS_MAX_CONCURRENT: "3" },
      jobsDirPath: dir,
      start: () => { calls += 1; return { file: "log.jsonl", id: "new-job" }; }
    });
    expect(result).toEqual({ file: "log.jsonl", id: "new-job" });
    expect(calls).toBe(1);
    expect(stderr.join("")).toBe("");
  });
});

describe("muse job delete", () => {
  function seed(dir: string, id: string, events: ReadonlyArray<Record<string, unknown>>): void {
    writeFileSync(join(dir, `${id}.jsonl`), events.map((ev) => JSON.stringify(ev)).join("\n"), "utf8");
  }
  async function runJob(args: readonly string[], dir: string): Promise<{ stdout: string; stderr: string }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = { stdout: (m: string) => stdout.push(m), stderr: (m: string) => stderr.push(m) };
    const prev = process.env.MUSE_JOBS_DIR;
    process.env.MUSE_JOBS_DIR = dir;
    try {
      const program = new Command();
      registerJobCommands(program, io);
      await program.parseAsync(["node", "muse", "job", ...args]);
    } finally {
      if (prev === undefined) delete process.env.MUSE_JOBS_DIR;
      else process.env.MUSE_JOBS_DIR = prev;
    }
    return { stderr: stderr.join(""), stdout: stdout.join("") };
  }

  it("removes a finished job's file (resolving an unambiguous prefix)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-job-del-"));
    seed(dir, "job_2026-05-15T10-00-00_done0001", [
      { prompt: "research", tsIso: "2026-05-15T10:00:00Z", type: "started" },
      { tsIso: "2026-05-15T10:01:00Z", type: "done" }
    ]);
    const r = await runJob(["delete", "job_2026-05-15T10-00-00_done"], dir);
    expect(r.stdout).toContain("Deleted job job_2026-05-15T10-00-00_done0001 (done)");
    expect(existsSync(join(dir, "job_2026-05-15T10-00-00_done0001.jsonl"))).toBe(false);
  });

  it("refuses a still-running job without --force, deletes it with --force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-job-del-run-"));
    const id = "job_2026-05-15T11-00-00_runn0002";
    seed(dir, id, [{ prompt: "draft", tsIso: "2026-05-15T11:00:00Z", type: "started" }]);
    const refused = await runJob(["delete", id], dir);
    expect(refused.stderr).toContain("still appears to be running");
    expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true);
    const forced = await runJob(["delete", id, "--force"], dir);
    expect(forced.stdout).toContain(`Deleted job ${id} (running)`);
    expect(existsSync(join(dir, `${id}.jsonl`))).toBe(false);
  });
});
