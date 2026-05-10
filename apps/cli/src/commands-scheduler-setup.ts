/**
 * `muse scheduler` and `muse setup` command groups, extracted from
 * apps/cli/src/program.ts.
 *
 * Both groups are self-contained: they only consume `apiRequest` /
 * `writeOutput` helpers (passed in as dependencies) and the
 * `runCalendarSetup` wizard. Pulling them out of program.ts keeps the
 * top-level command file focused on the cross-cutting plumbing
 * (config / auth / chat / TUI).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import {
  resolveLocalCalendarFile,
  resolveNotesDir,
  resolveTasksFile
} from "@muse/autoconfigure";
import type { Command } from "commander";

import { runCalendarSetup } from "./setup-calendar.js";
import type { ProgramIO } from "./program.js";

export interface SchedulerSetupHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerSchedulerCommands(program: Command, io: ProgramIO, helpers: SchedulerSetupHelpers): void {
  const { apiRequest, writeOutput } = helpers;
  const scheduler = program.command("scheduler").description("Manage scheduled jobs");

  scheduler
    .command("list")
    .description("List scheduled jobs")
    .action(async (_options, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/scheduler/jobs"));
    });

  scheduler
    .command("create-agent")
    .description("Create an agent scheduled job")
    .argument("<name>", "Job name")
    .argument("<cron>", "Cron expression")
    .argument("<prompt...>", "Agent prompt")
    .option("--model <model>", "Agent model")
    .option("--disabled", "Create disabled")
    .action(async (name: string, cronExpression: string, promptParts: readonly string[], options: { readonly model?: string; readonly disabled?: boolean }, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/scheduler/jobs", {
        agentModel: options.model,
        agentPrompt: promptParts.join(" "),
        cronExpression,
        enabled: !options.disabled,
        jobType: "agent",
        name
      }));
    });

  scheduler
    .command("trigger")
    .description("Trigger a scheduled job")
    .argument("<job-id>", "Job ID")
    .action(async (jobId: string, _options, command) => {
      writeOutput(
        io,
        await apiRequest(io, command, `/api/scheduler/jobs/${encodeURIComponent(jobId)}/trigger`, undefined, "POST")
      );
    });

  scheduler
    .command("dry-run")
    .description("Dry-run a scheduled job")
    .argument("<job-id>", "Job ID")
    .action(async (jobId: string, _options, command) => {
      writeOutput(
        io,
        await apiRequest(io, command, `/api/scheduler/jobs/${encodeURIComponent(jobId)}/dry-run`, undefined, "POST")
      );
    });
}

export function registerSetupCommands(program: Command, io: ProgramIO): void {
  const setup = program.command("setup").description("Survey or configure Muse (no args → status report)");

  setup
    .command("status", { isDefault: true })
    .description("Print a configuration health-check (model, MCP, calendar, notes, tasks)")
    .action(async () => {
      io.stdout(await renderSetupStatus());
    });

  setup
    .command("calendar")
    .description("Configure calendar providers (local / google / caldav / macos) and store credentials")
    .action(async () => {
      await runCalendarSetup({ stderr: io.stderr, stdout: io.stdout });
    });
}

async function renderSetupStatus(): Promise<string> {
  const env = process.env as Record<string, string | undefined>;
  const home = homedir();
  const lines: string[] = ["Muse setup status:"];

  const modelEnv = env.MUSE_MODEL?.trim() ?? "";
  const apiKeyHits = countConfiguredApiKeys(env);
  if (modelEnv.length > 0 || apiKeyHits.total > 0) {
    const detail: string[] = [];
    if (modelEnv.length > 0) {
      detail.push(`MUSE_MODEL=${modelEnv}`);
    }
    if (apiKeyHits.total > 0) {
      detail.push(`${apiKeyHits.total} provider key(s): ${apiKeyHits.names.join(", ")}`);
    }
    lines.push(`  [ok]   model — ${detail.join(", ")}`);
  } else {
    lines.push("  [todo] model — set MUSE_MODEL and a provider key (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY / OLLAMA_BASE_URL)");
  }

  const mcpFile = env.MUSE_MCP_CONFIG?.trim() && env.MUSE_MCP_CONFIG.trim().length > 0
    ? env.MUSE_MCP_CONFIG.trim()
    : pathJoin(home, ".muse", "mcp.json");
  const mcpCount = await readMcpEntryCount(mcpFile);
  if (mcpCount > 0) {
    lines.push(`  [ok]   mcp — ${mcpCount} external server(s) in ${mcpFile}`);
  } else {
    lines.push(`  [info] mcp — no external entries (${mcpFile}); add with \`muse mcp config-add\``);
  }

  const calendarFile = resolveLocalCalendarFile(env);
  const calendarSize = await statBytes(calendarFile);
  if (calendarSize !== undefined) {
    lines.push(`  [ok]   calendar (local) — ${calendarFile} (${formatBytes(calendarSize)})`);
  } else {
    lines.push(`  [info] calendar (local) — ${calendarFile} not yet created`);
  }
  const credentialsFile = pathJoin(home, ".muse", "credentials.json");
  const credentialsSize = await statBytes(credentialsFile);
  if (credentialsSize !== undefined) {
    lines.push(`  [ok]   calendar (oauth/caldav) — credentials in ${credentialsFile}`);
  } else {
    lines.push("  [info] calendar (oauth/caldav) — no credentials yet; run `muse setup calendar`");
  }

  const notesDir = resolveNotesDir(env);
  const notesCount = await countNotes(notesDir);
  if (notesCount === undefined) {
    lines.push(`  [info] notes — ${notesDir} not yet created`);
  } else {
    lines.push(`  [ok]   notes — ${notesCount} file(s) under ${notesDir}`);
  }

  const tasksFile = resolveTasksFile(env);
  const tasksCount = await readTaskCount(tasksFile);
  if (tasksCount === undefined) {
    lines.push(`  [info] tasks — ${tasksFile} not yet created`);
  } else {
    lines.push(`  [ok]   tasks — ${tasksCount} entry/entries in ${tasksFile}`);
  }

  const voiceConfigured = Boolean(
    env.OPENAI_API_KEY?.trim() || env.MUSE_VOICE_OPENAI_API_KEY?.trim()
  );
  if (voiceConfigured) {
    lines.push("  [ok]   voice — OpenAI key present (Whisper STT + TTS available)");
  } else {
    lines.push("  [info] voice — set OPENAI_API_KEY (or MUSE_VOICE_OPENAI_API_KEY) to enable `muse listen` / TTS");
  }

  lines.push("");
  lines.push("Wizards:");
  lines.push("  muse setup calendar   — OAuth / CalDAV / macOS calendar credentials");
  lines.push("  muse mcp config-add   — register an external MCP server");
  return `${lines.join("\n")}\n`;
}

function countConfiguredApiKeys(env: Record<string, string | undefined>): { total: number; names: string[] } {
  const candidates: ReadonlyArray<{ key: string; label: string }> = [
    { key: "OPENAI_API_KEY", label: "openai" },
    { key: "ANTHROPIC_API_KEY", label: "anthropic" },
    { key: "GEMINI_API_KEY", label: "gemini" },
    { key: "OPENROUTER_API_KEY", label: "openrouter" },
    { key: "OLLAMA_BASE_URL", label: "ollama" }
  ];
  const present = candidates.filter((entry) => (env[entry.key] ?? "").trim().length > 0);
  return { names: present.map((entry) => entry.label), total: present.length };
}

async function readMcpEntryCount(file: string): Promise<number> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object") {
      return Object.keys(parsed.mcpServers).length;
    }
  } catch {
    // missing / malformed → treat as zero
  }
  return 0;
}

async function statBytes(file: string): Promise<number | undefined> {
  try {
    const stat = await fs.stat(file);
    return stat.size;
  } catch {
    return undefined;
  }
}

async function countNotes(dir: string): Promise<number | undefined> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.isFile() && /\.(md|markdown|txt)$/iu.test(entry.name)) {
        total += 1;
      } else if (entry.isDirectory()) {
        total += 1; // count subdirs as a single bucket without recursing — `muse today` does the deep walk
      }
    }
    return total;
  } catch {
    return undefined;
  }
}

async function readTaskCount(file: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { tasks?: unknown };
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.tasks)) {
      return parsed.tasks.length;
    }
    return 0;
  } catch {
    return undefined;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
