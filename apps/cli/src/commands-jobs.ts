/**
 * `muse job run/status/list/tail` — background long-running tasks.
 *
 * `muse job run <prompt>` spawns a detached worker (the default)
 * that runs the prompt through the local agent runtime, streaming
 * progress to `~/.muse/jobs/<id>.jsonl`. The parent returns
 * immediately with the job id; `--no-background` runs it inline
 * instead. `muse job status <id>` (or `tail`) reads the file
 * back. `muse job list` shows recent jobs.
 *
 * Why this matters for JARVIS-class: real assistants take ownership of
 * multi-minute work — researching a topic, drafting a long doc, running
 * an analysis — and report back when done. Cron is wrong shape
 * (recurring, not one-shot). The agent runtime exists; this command
 * just wraps it in a fire-and-forget detached child + a status surface.
 *
 * Pure file IO + child_process.spawn. No daemon, no queue, no DB.
 * Open-source + zero recurring cost.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";

const here = pathDirname(fileURLToPath(import.meta.url));

import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import { resolveJobIdByPrefix } from "./job-id-prefix.js";
import { resolvePersona } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";

/**
 * Goal 151 — accepted values for `muse job list --status`.
 * Mirrors `jobSummary().status` plus `"all"` (the default,
 * meaning no filter). Kept as a readonly tuple so commander
 * + the fuzzy-suggest hint share a single source of truth.
 */
export const JOB_STATUS_FILTER_VALUES = ["all", "running", "done", "error", "unknown"] as const;
export type JobStatusFilter = (typeof JOB_STATUS_FILTER_VALUES)[number];

/**
 * Goal 151 — case-insensitive validation. Returns `"all"` when
 * the user omitted the flag, `"invalid"` when it's not a
 * known value (caller renders the typo hint), otherwise the
 * normalised filter to compare against `jobSummary().status`.
 */
export function resolveJobStatusFilter(input: string | undefined): JobStatusFilter | "invalid" {
  if (input === undefined) return "all";
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) return "all";
  if ((JOB_STATUS_FILTER_VALUES as readonly string[]).includes(trimmed)) {
    return trimmed as JobStatusFilter;
  }
  return "invalid";
}

// Blank → default 20; a genuine number is truncated + clamped
// to [1, 200]; a unit slip / non-numeric / non-positive value
// rejects rather than silently using 20.
export function parseJobListLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return 20;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--limit must be a positive number (got '${raw}')`);
  }
  return Math.min(200, Math.trunc(parsed));
}

function jobsDir(): string {
  return process.env.MUSE_JOBS_DIR?.trim() ?? pathJoin(homedir(), ".muse", "jobs");
}

function jobPath(id: string): string {
  return pathJoin(jobsDir(), `${id}.jsonl`);
}

/**
 * Goal 150 — list known job ids by reading the jobs dir.
 * Returns [] when the dir doesn't exist yet (fresh install /
 * never ran `muse job run`).
 */
function listKnownJobIds(): readonly string[] {
  const dir = jobsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.replace(/\.jsonl$/u, ""));
}

/**
 * Goal 150 — resolve a user-supplied job id (full or unique prefix)
 * to a concrete id, or render the right "not found / ambiguous"
 * error and set the exit code. Centralises the resolution UX so
 * `muse job status` and `muse job tail` behave identically.
 *
 * Returns the resolved id on success; `undefined` when the caller
 * should bail (the error message + exit code were already
 * emitted).
 */
function resolveOrReportJobId(io: ProgramIO, input: string, command: string): string | undefined {
  const known = listKnownJobIds();
  const outcome = resolveJobIdByPrefix(input, known);
  switch (outcome.kind) {
    case "exact":
    case "prefix":
      return outcome.id;
    case "ambiguous": {
      io.stderr(`${command}: '${input}' matches ${outcome.matches.length.toString()} jobs:\n`);
      for (const match of outcome.matches) {
        io.stderr(`  ${match}\n`);
      }
      io.stderr("Pass a longer prefix to disambiguate.\n");
      process.exitCode = 1;
      return undefined;
    }
    case "none":
      io.stderr(`${command}: no job matches '${input}' (run \`muse job list\` to see ids)\n`);
      process.exitCode = 1;
      return undefined;
  }
}

interface JobEvent {
  readonly type: "started" | "progress" | "result" | "error" | "done";
  readonly tsIso: string;
  readonly text?: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly userKey?: string;
}

async function readJobLines(file: string): Promise<readonly JobEvent[]> {
  try {
    const raw = await readFile(file, "utf8");
    const out: JobEvent[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line) as JobEvent);
      } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
}

function jobSummary(events: readonly JobEvent[]): {
  readonly status: "running" | "done" | "error" | "unknown";
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly prompt?: string;
  readonly finalText?: string;
  readonly error?: string;
} {
  let status: "running" | "done" | "error" | "unknown" = "unknown";
  let startedAt: string | undefined, finishedAt: string | undefined;
  let prompt: string | undefined, finalText = "", error: string | undefined;
  for (const ev of events) {
    if (ev.type === "started") {
      status = "running";
      startedAt = ev.tsIso;
      prompt = ev.prompt;
    } else if (ev.type === "progress") {
      finalText += ev.text ?? "";
    } else if (ev.type === "result") {
      finalText = ev.text ?? finalText;
    } else if (ev.type === "error") {
      status = "error";
      error = ev.text;
      finishedAt = ev.tsIso;
    } else if (ev.type === "done") {
      if (status !== "error") status = "done";
      finishedAt = ev.tsIso;
    }
  }
  return { error, finalText, finishedAt, prompt, startedAt, status };
}

export function registerJobCommands(program: Command, io: ProgramIO): void {
  const job = program.command("job").description("Background long-running agent tasks");

  job
    .command("run")
    .description("Run a prompt in the background; returns the job id immediately. Output streams to ~/.muse/jobs/<id>.jsonl")
    .argument("<prompt...>", "Free-text prompt")
    .option("--no-background", "Run the worker inline (stream output through) instead of detaching. Default: detached.")
    .option("--model <tag>", "Model override")
    .option("--user <id>", "User identity (default $MUSE_USER_ID)")
    .option("--persona <slot>", "Persona slot")
    .option("--no-tools", "Run with the chat-only fast path (no tool registry)")
    .action(async (
      promptParts: readonly string[],
      options: {
        readonly background?: boolean;
        readonly model?: string;
        readonly user?: string;
        readonly persona?: string;
        readonly tools?: boolean;
      }
    ) => {
      const prompt = promptParts.join(" ").trim();
      if (prompt.length === 0) {
        io.stderr("usage: muse job run <prompt>\n");
        process.exitCode = 1;
        return;
      }
      const id = `job_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_${randomUUID().slice(0, 8)}`;
      const dir = jobsDir();
      mkdirSync(dir, { recursive: true });
      const file = jobPath(id);

      const env = { ...process.env };
      const resolvedPersona = resolvePersona(options.persona);
      const argv = [
        `--job-id=${id}`,
        `--job-file=${file}`,
        `--job-prompt=${prompt}`,
        ...(options.model ? [`--job-model=${options.model}`] : []),
        ...(options.user ? [`--job-user=${options.user}`] : []),
        ...(resolvedPersona ? [`--job-persona=${resolvedPersona}`] : []),
        ...(options.tools === false ? ["--job-no-tools"] : [])
      ];
      const workerPath = pathJoin(here, "job-worker.js");

      if (options.background === false) {
        // Inline mode — spawn but stream stdout/stderr through.
        const child = spawn(process.execPath, [workerPath, ...argv], { stdio: "inherit" });
        await new Promise<void>((resolve) => child.on("close", () => resolve()));
        io.stdout(`\nDone. Job log: ${file}\n`);
        return;
      }

      const child = spawn(process.execPath, [workerPath, ...argv], {
        detached: true,
        env,
        stdio: "ignore"
      });
      child.unref();
      io.stdout(`Started ${id}\n  log: ${file}\n  status: muse job status ${id}\n`);
    });

  job
    .command("status")
    .description("Show the latest snapshot of a job — running/done/error + final text so far")
    .argument("<id>", "Job id or unique prefix (from `muse job list` or the `run` output)")
    .option("--json", "Emit machine-readable JSON")
    .action(async (id: string, options: { readonly json?: boolean }) => {
      const resolved = resolveOrReportJobId(io, id, "muse job status");
      if (resolved === undefined) return;
      const file = jobPath(resolved);
      const events = await readJobLines(file);
      if (events.length === 0) {
        io.stderr(`Job '${resolved}' has no events yet (file ${file})\n`);
        process.exitCode = 1;
        return;
      }
      const summary = jobSummary(events);
      if (options.json) {
        io.stdout(`${JSON.stringify({ events: events.length, file, id: resolved, ...summary }, null, 2)}\n`);
        return;
      }
      io.stdout(`Job ${resolved}: ${summary.status}\n`);
      if (summary.prompt) io.stdout(`  prompt: ${summary.prompt}\n`);
      if (summary.startedAt) io.stdout(`  started: ${summary.startedAt}\n`);
      if (summary.finishedAt) io.stdout(`  finished: ${summary.finishedAt}\n`);
      if (summary.error) io.stdout(`  error: ${summary.error}\n`);
      if (summary.finalText && summary.finalText.length > 0) {
        io.stdout(`  output:\n${summary.finalText.split("\n").map((l) => `    ${l}`).join("\n")}\n`);
      }
    });

  job
    .command("list")
    .description("Recent jobs (newest first)")
    .option("--limit <n>", "Max entries (default 20)", "20")
    .option(
      "--status <state>",
      "Only show jobs with this status: running, done, error, unknown, or all (default: all)"
    )
    .option("--json", "Emit a structured payload (parity with `muse job status --json`)")
    .action(async (options: { readonly limit: string; readonly status?: string; readonly json?: boolean }) => {
      const dir = jobsDir();
      if (!existsSync(dir)) {
        if (options.json) {
          io.stdout(`${JSON.stringify({ dir, jobs: [], matched: 0, status: "all" }, null, 2)}\n`);
        } else {
          io.stdout(`No jobs yet (dir ${dir} doesn't exist).\n`);
        }
        return;
      }
      // Validate before scanning so `--status runing` gets a
      // fuzzy hint instead of silently filtering to zero.
      const statusFilter = resolveJobStatusFilter(options.status);
      if (statusFilter === "invalid") {
        const suggestion = closestCommandName(options.status!.trim(), JOB_STATUS_FILTER_VALUES);
        io.stderr(`muse job list: invalid --status '${options.status!}'`);
        if (suggestion) io.stderr(` — did you mean '${suggestion}'?`);
        io.stderr(` (valid: ${JOB_STATUS_FILTER_VALUES.join(", ")})\n`);
        process.exitCode = 1;
        return;
      }
      const limit = parseJobListLimit(options.limit);
      const files = readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .reverse();
      const matched: Array<{ id: string; status: ReturnType<typeof jobSummary>["status"]; prompt: string }> = [];
      for (const name of files) {
        if (matched.length >= limit) break;
        const id = name.replace(/\.jsonl$/u, "");
        const events = await readJobLines(pathJoin(dir, name));
        const summary = jobSummary(events);
        if (statusFilter !== "all" && summary.status !== statusFilter) continue;
        matched.push({ id, prompt: summary.prompt ?? "", status: summary.status });
      }
      if (options.json) {
        // status echoes the active filter so consumers can tell
        // "no jobs ever" from "none matched the filter".
        io.stdout(`${JSON.stringify({
          dir,
          jobs: matched,
          matched: matched.length,
          status: statusFilter
        }, null, 2)}\n`);
        return;
      }
      io.stdout(`${matched.length.toString()} job(s) in ${dir}${statusFilter === "all" ? "" : ` (status=${statusFilter})`}:\n`);
      for (const entry of matched) {
        const flag = entry.status === "done" ? "✓" : entry.status === "error" ? "✗" : entry.status === "running" ? "…" : "?";
        const preview = entry.prompt.slice(0, 60);
        io.stdout(`  ${flag} ${entry.id}  ${preview}${entry.prompt.length > 60 ? "…" : ""}\n`);
      }
    });

  job
    .command("tail")
    .description("Live-follow a job's progress events (tail -f equivalent)")
    .argument("<id>", "Job id or unique prefix")
    .action(async (id: string) => {
      // Resolve before the tail loop so an ambiguous prefix isn't
      // mistaken for a missing file.
      const resolved = resolveOrReportJobId(io, id, "muse job tail");
      if (resolved === undefined) return;
      const file = jobPath(resolved);
      io.stdout(`tailing ${file} (Ctrl-C to stop)\n\n`);
      let last = 0;
      const tick = async (): Promise<void> => {
        try {
          const raw = readFileSync(file, "utf8");
          if (raw.length > last) {
            io.stdout(raw.slice(last));
            last = raw.length;
          }
        } catch { /* not yet created */ }
      };
      const interval = setInterval(() => { void tick(); }, 500);
      process.on("SIGINT", () => { clearInterval(interval); process.exit(0); });
      await new Promise(() => { /* hold */ });
    });

  // job append helper exposed for the worker child process.
  // Re-exported via a tiny wrapper so the worker (in job-worker.ts)
  // can append events without re-importing the helper.
}

export async function appendJobEvent(file: string, event: JobEvent): Promise<void> {
  await appendFile(file, `${JSON.stringify({ ...event, tsIso: event.tsIso ?? new Date().toISOString() })}\n`, { mode: 0o600 });
}
