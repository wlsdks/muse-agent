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
  mergeModelKeysFromFile,
  resolveLocalCalendarFile,
  resolveMessagingCredentialsFile,
  resolveNotesDir,
  resolveTasksFile
} from "@muse/autoconfigure";
import type { Command } from "commander";

import { runCalendarSetup } from "./setup-calendar.js";
import { runMessagingSetup } from "./setup-messaging.js";
import { runModelSetup } from "./setup-model.js";
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

  setup
    .command("messaging")
    .description("Configure messenger providers (telegram / discord / slack / line) and store tokens")
    .action(async () => {
      await runMessagingSetup({ stderr: io.stderr, stdout: io.stdout });
    });

  setup
    .command("model")
    .description("Configure LLM provider keys (openai / anthropic / gemini / openrouter / ollama)")
    .action(async () => {
      await runModelSetup({ stderr: io.stderr, stdout: io.stdout });
    });
}

async function renderSetupStatus(): Promise<string> {
  // Mirror autoconfigure's runtime boot: lift ~/.muse/models.json
  // tokens (+ derived MUSE_MODEL) into env so the status reflects
  // what the next `muse` invocation actually sees, not just raw
  // process.env. Without this, a freshly-`setup model`'d user would
  // see `[todo] model` even though autoconfigure would happily wire
  // them up next boot.
  const env = mergeModelKeysFromFile(process.env as Record<string, string | undefined>);
  const home = homedir();
  const lines: string[] = ["Muse setup status:"];

  const modelEnv = env.MUSE_MODEL?.trim() ?? "";
  const modelKeysFile = env.MUSE_MODEL_KEYS_FILE?.trim() && env.MUSE_MODEL_KEYS_FILE.trim().length > 0
    ? env.MUSE_MODEL_KEYS_FILE.trim()
    : pathJoin(home, ".muse", "models.json");
  const modelKeyHits = await readModelKeyState(modelKeysFile, env);
  if (modelEnv.length > 0 || modelKeyHits.length > 0) {
    const detail: string[] = [];
    if (modelEnv.length > 0) {
      detail.push(`MUSE_MODEL=${modelEnv}`);
    }
    if (modelKeyHits.length > 0) {
      detail.push(`${modelKeyHits.length.toString()} provider key(s): ${modelKeyHits.join(", ")}`);
    }
    lines.push(`  [ok]   model — ${detail.join(", ")}`);
  } else {
    lines.push("  [todo] model — run `muse setup model` (autoloads from ~/.muse/models.json)");
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
    lines.push("  [info] voice — run `muse setup model` and pick OpenAI (or export MUSE_VOICE_OPENAI_API_KEY) to enable `muse listen` / TTS");
  }

  const messagingFile = resolveMessagingCredentialsFile(env);
  const messagingHits = await readMessagingProviderState(messagingFile, env);
  if (messagingHits.length > 0) {
    lines.push(`  [ok]   messaging — ${messagingHits.join(", ")}`);
  } else {
    lines.push("  [info] messaging — no providers yet; run `muse setup messaging`");
  }

  lines.push("");
  lines.push("Wizards:");
  lines.push("  muse setup model       — LLM provider keys (OpenAI / Anthropic / Gemini / OpenRouter / Ollama)");
  lines.push("  muse setup calendar    — OAuth / CalDAV / macOS calendar credentials");
  lines.push("  muse setup messaging   — Telegram / Discord / Slack / LINE bot tokens");
  lines.push("  muse mcp config-add    — register an external MCP server");
  return `${lines.join("\n")}\n`;
}

async function readModelKeyState(
  file: string,
  env: Record<string, string | undefined>
): Promise<readonly string[]> {
  let storedProviders: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
    if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
      storedProviders = parsed.providers;
    }
  } catch {
    // missing or malformed → treat as empty
  }
  const lines: string[] = [];
  const probe = (id: string, envKey: string): void => {
    const fromEnv = env[envKey]?.trim();
    const fromFile = isRecord(storedProviders[id]) && typeof storedProviders[id].token === "string"
      ? "file"
      : undefined;
    if (fromEnv && fromEnv.length > 0) {
      lines.push(`${id} (env)`);
    } else if (fromFile) {
      lines.push(`${id} (file)`);
    }
  };
  probe("openai", "OPENAI_API_KEY");
  probe("anthropic", "ANTHROPIC_API_KEY");
  probe("gemini", "GEMINI_API_KEY");
  probe("openrouter", "OPENROUTER_API_KEY");
  probe("ollama", "OLLAMA_BASE_URL");
  return lines;
}

async function readMessagingProviderState(
  file: string,
  env: Record<string, string | undefined>
): Promise<readonly string[]> {
  let storedProviders: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
    if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
      storedProviders = parsed.providers;
    }
  } catch {
    // missing or malformed → treat as empty
  }
  const lines: string[] = [];
  const probe = (id: string, envKey: string): void => {
    const fromEnv = env[envKey]?.trim();
    const fromFile = isRecord(storedProviders[id]) && typeof storedProviders[id].token === "string"
      ? "file"
      : undefined;
    if (fromEnv && fromEnv.length > 0) {
      lines.push(`${id} (env)`);
    } else if (fromFile) {
      lines.push(`${id} (file)`);
    }
  };
  probe("telegram", "MUSE_TELEGRAM_BOT_TOKEN");
  probe("discord", "MUSE_DISCORD_BOT_TOKEN");
  probe("slack", "MUSE_SLACK_BOT_TOKEN");
  probe("line", "MUSE_LINE_CHANNEL_ACCESS_TOKEN");
  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
