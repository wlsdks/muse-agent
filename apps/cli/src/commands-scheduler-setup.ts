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

import { collectSetupStatusJson } from "@muse/autoconfigure";
import type { Command } from "commander";

import { runCalendarSetup } from "./setup-calendar.js";
import { runMessagingSetup } from "./setup-messaging.js";
import { runModelSetup, SETUP_MODEL_PROVIDER_SPECS } from "./setup-model.js";
import type { ProgramIO } from "./program.js";

function providerIdList(): string {
  return SETUP_MODEL_PROVIDER_SPECS.map((spec) => spec.id).join(" / ");
}

export interface SchedulerSetupHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
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

  scheduler
    .command("delete")
    .description("Delete a scheduled job")
    .argument("<job-id>", "Job ID")
    .action(async (jobId: string, _options, command) => {
      writeOutput(
        io,
        await apiRequest(io, command, `/api/scheduler/jobs/${encodeURIComponent(jobId)}`, undefined, "DELETE")
      );
    });

  scheduler
    .command("executions")
    .description("List recent executions for a scheduled job")
    .argument("<job-id>", "Job ID")
    .action(async (jobId: string, _options, command) => {
      writeOutput(
        io,
        await apiRequest(io, command, `/api/scheduler/jobs/${encodeURIComponent(jobId)}/executions`)
      );
    });
}

export function registerSetupCommands(program: Command, io: ProgramIO): void {
  const setup = program.command("setup").description("Survey or configure Muse (no args → status report)");

  setup
    .command("status", { isDefault: true })
    .description("Print a configuration health-check (model, MCP, calendar, notes, tasks, voice, messaging, web search)")
    .option("--json", "Emit structured JSON instead of the formatted status report")
    .action(async (options: { readonly json?: boolean }) => {
      if (options.json) {
        const snapshot = await collectSetupStatusJson();
        io.stdout(`${JSON.stringify(snapshot, null, 2)}\n`);
        return;
      }
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
    .description(`Configure LLM provider keys (${providerIdList()})`)
    .action(async () => {
      await runModelSetup({ stderr: io.stderr, stdout: io.stdout });
    });

  setup
    .command("wizard")
    .description("End-to-end onboarding: model → calendar → messaging in one pass")
    .action(async () => {
      await runSetupWizard({ stderr: io.stderr, stdout: io.stdout });
    });
}

/**
 * Sequential wizard — walks the user through every setup step in
 * one terminal session. Each step uses the same routine the
 * dedicated `muse setup <area>` command runs, so an interrupted
 * wizard can be resumed by running that individual command later.
 *
 * Order is fixed: model first (a runtime without a model can't
 * answer anything, so this is the most-critical step), then
 * calendar (local provider works offline, optional remote
 * providers later), then messaging (Slack/Discord/Telegram/LINE).
 */
async function runSetupWizard(io: { stderr(line: string): void; stdout(line: string): void }): Promise<void> {
  io.stdout("");
  io.stdout("─── Muse setup wizard ────────────────────────────");
  io.stdout("Three steps: model → calendar → messaging.");
  io.stdout("You can stop at any step and resume with `muse setup <area>` later.");
  io.stdout("");

  io.stdout("[1/3] Model provider");
  io.stdout("─────────────────────");
  await runModelSetup(io);
  io.stdout("");

  io.stdout("[2/3] Calendar");
  io.stdout("─────────────────");
  await runCalendarSetup(io);
  io.stdout("");

  io.stdout("[3/3] Messaging");
  io.stdout("──────────────────");
  await runMessagingSetup(io);
  io.stdout("");

  io.stdout("──── Wizard complete ────");
  io.stdout("Run `muse setup` (no args) to verify the final health-check report.");
  io.stdout("");
}

async function renderSetupStatus(): Promise<string> {
  // Single source of truth: format the same snapshot the REST + web
  // surfaces consume, so the per-section guidance under each [todo]/
  // [info] row matches the `nextStep` strings the snapshot owns.
  // Without this, the text renderer drifts from the structured
  // shape every time someone touches a wizard wording.
  const snap = await collectSetupStatusJson();
  const lines: string[] = ["Muse setup status:"];

  // Pretty-print the [ok] / [todo] / [info] prefix the existing
  // text contract expects, with a 6-char right-pad so labels align.
  const tag = (status: "ok" | "todo" | "info"): string =>
    status === "ok" ? "[ok]  " : status === "todo" ? "[todo]" : "[info]";
  const push = (status: "ok" | "todo" | "info", label: string, detail: string): void => {
    lines.push(`  ${tag(status)} ${label} — ${detail}`);
  };
  const pushNext = (nextStep: string | undefined): void => {
    if (nextStep) {
      lines.push(`         → ${nextStep}`);
    }
  };

  // model
  if (snap.model.status === "ok") {
    const detail: string[] = [];
    if (snap.model.muse_model) {
      detail.push(`MUSE_MODEL=${snap.model.muse_model}`);
    }
    if (snap.model.providerKeys.length > 0) {
      detail.push(`${snap.model.providerKeys.length.toString()} provider key(s): ${snap.model.providerKeys.join(", ")}`);
    }
    push("ok", "model", detail.join(", "));
  } else {
    push("todo", "model", "not configured");
    pushNext(snap.model.nextStep);
  }

  // mcp
  if (snap.mcp.status === "ok") {
    push("ok", "mcp", `${snap.mcp.externalServerCount.toString()} external server(s) in ${snap.mcp.file}`);
  } else {
    push("info", "mcp", `no external entries (${snap.mcp.file})`);
    pushNext(snap.mcp.nextStep);
  }

  // calendar (local)
  if (snap.calendar.local.status === "ok") {
    const bytes = snap.calendar.local.bytes;
    push("ok", "calendar (local)", `${snap.calendar.local.file}${bytes !== undefined ? ` (${formatBytes(bytes)})` : ""}`);
  } else {
    push("info", "calendar (local)", `${snap.calendar.local.file} not yet created`);
    pushNext(snap.calendar.local.nextStep);
  }
  // calendar (oauth/caldav)
  if (snap.calendar.credentials.status === "ok") {
    push("ok", "calendar (oauth/caldav)", `credentials in ${snap.calendar.credentials.file}`);
  } else {
    push("info", "calendar (oauth/caldav)", "no credentials yet");
    pushNext(snap.calendar.credentials.nextStep);
  }

  // notes
  if (snap.notes.status === "ok") {
    push("ok", "notes", `${(snap.notes.fileCount ?? 0).toString()} file(s) under ${snap.notes.dir}`);
  } else {
    push("info", "notes", `${snap.notes.dir} not yet created`);
    pushNext(snap.notes.nextStep);
  }

  // tasks
  if (snap.tasks.status === "ok") {
    push("ok", "tasks", `${(snap.tasks.entryCount ?? 0).toString()} entry/entries in ${snap.tasks.file}`);
  } else {
    push("info", "tasks", `${snap.tasks.file} not yet created`);
    pushNext(snap.tasks.nextStep);
  }

  // voice
  if (snap.voice.status === "ok") {
    push("ok", "voice", "OpenAI key present (Whisper STT + TTS available)");
  } else {
    push("info", "voice", "no key");
    pushNext(snap.voice.nextStep);
  }

  // messaging
  if (snap.messaging.status === "ok") {
    push("ok", "messaging", snap.messaging.providers.join(", "));
  } else {
    push("info", "messaging", "no providers yet");
    pushNext(snap.messaging.nextStep);
  }

  // web search
  const ws = snap.webSearch;
  push(
    "ok",
    "web search",
    ws.enabled
      ? `enabled (maxUses ${ws.maxUses.toString()}, source=${ws.source})`
      : `disabled (source=${ws.source})`
  );

  lines.push("");
  lines.push("Wizards:");
  lines.push("  muse setup wizard      — end-to-end onboarding (model → calendar → messaging)");
  lines.push(`  muse setup model       — LLM provider keys (${providerIdList()})`);
  lines.push("  muse setup calendar    — OAuth / CalDAV / macOS calendar credentials");
  lines.push("  muse setup messaging   — Telegram / Discord / Slack / LINE bot tokens");
  lines.push("  muse mcp config-add    — register an external MCP server");
  return `${lines.join("\n")}\n`;
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
