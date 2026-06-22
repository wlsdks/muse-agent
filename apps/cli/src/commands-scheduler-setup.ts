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

import { collectSetupStatusJson, resolveFollowupsFile, type SetupStatusSnapshot } from "@muse/autoconfigure";
import { readFollowups } from "@muse/stores";
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

  scheduler
    .command("next")
    .description("Show what's scheduled to fire next: scheduler jobs + pending reminders + scheduled followups, soonest first")
    .option("--limit <n>", "How many entries to surface (default 5)")
    .option("--json", "Emit structured JSON instead of the formatted preview")
    .action(async (options: { readonly limit?: string; readonly json?: boolean }, command) => {
      const limit = Math.max(1, Math.min(50, Number.parseInt(options.limit ?? "5", 10) || 5));
      const [jobs, reminders, followups] = await Promise.all([
        apiRequest(io, command, "/api/scheduler/jobs")
          .then((value) => Array.isArray((value as { jobs?: unknown[] }).jobs)
            ? ((value as { jobs: SchedulerJobRow[] }).jobs)
            : Array.isArray(value) ? (value as SchedulerJobRow[]) : [])
          .catch(() => [] as SchedulerJobRow[]),
        apiRequest(io, command, "/api/reminders?status=pending")
          .then((value) => ((value as { reminders?: PendingReminderRow[] }).reminders) ?? [])
          .catch(() => [] as PendingReminderRow[]),
        // Followups are a local-only store (no REST surface) but fire
        // at `scheduledFor` exactly like a reminder, so a "what's next"
        // that omits them hides self-queued promises ("I'll check in
        // 30 min"). Read locally; fail-soft to none.
        readFollowups(resolveFollowupsFile(process.env as Record<string, string | undefined>))
          .catch(() => [])
      ]);
      const merged: PreviewEntry[] = [];
      for (const job of jobs) {
        if (!job.nextRunAt) continue;
        merged.push({
          when: job.nextRunAt,
          kind: "job",
          label: `${job.name ?? job.id ?? "(unnamed)"} — cron ${job.cronExpression ?? "?"}`
        });
      }
      for (const rem of reminders) {
        merged.push({
          when: rem.dueAt,
          kind: "reminder",
          label: rem.text ?? "(no text)"
        });
      }
      for (const followup of followups) {
        if (followup.status !== "scheduled") continue;
        merged.push({
          when: followup.scheduledFor,
          kind: "followup",
          label: followup.summary || "(no summary)"
        });
      }
      const upcoming = merged
        .filter((e) => typeof e.when === "string" && e.when.length > 0)
        .sort(comparePreviewEntriesByWhen)
        .slice(0, limit);
      if (options.json) {
        writeOutput(io, { entries: upcoming, total: upcoming.length });
        return;
      }
      if (upcoming.length === 0) {
        io.stdout("Nothing scheduled next.\n");
        return;
      }
      io.stdout(`Next ${upcoming.length.toString()} scheduled item(s):\n`);
      for (const entry of upcoming) {
        io.stdout(`  · ${entry.when}  [${entry.kind}] ${entry.label}\n`);
      }
    });
}

interface SchedulerJobRow {
  readonly id?: string;
  readonly name?: string;
  readonly cronExpression?: string;
  readonly nextRunAt?: string;
  readonly enabled?: boolean;
}

interface PendingReminderRow {
  readonly id?: string;
  readonly text?: string;
  readonly dueAt?: string;
}

export interface PreviewEntry {
  readonly when?: string;
  readonly kind: "job" | "reminder" | "followup";
  readonly label: string;
}

// Order the merged jobs+reminders preview by PARSED INSTANT, not raw
// ISO string: `when` mixes a reminder's free-form dueAt (mixed
// precision / timezone offset — hand-edited, imported) with a job's
// nextRunAt, so a lexicographic compare mis-orders (`…-05:00` later
// than `…Z` sorts first) and the `.slice(limit)` could then drop a
// genuinely-sooner item. Unparseable values keep a deterministic
// string order; ties break by label.
export function comparePreviewEntriesByWhen(a: PreviewEntry, b: PreviewEntry): number {
  const am = Date.parse(a.when ?? "");
  const bm = Date.parse(b.when ?? "");
  if (Number.isFinite(am) && Number.isFinite(bm)) {
    if (am !== bm) {
      return am - bm;
    }
  } else if ((a.when ?? "") !== (b.when ?? "")) {
    return (a.when ?? "").localeCompare(b.when ?? "");
  }
  return a.label.localeCompare(b.label);
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
  return `${formatSetupStatusLines(snap).join("\n")}\n`;
}

/**
 * Pure snapshot → text-line renderer. Exported for direct coverage:
 * the async collector reads global env + the filesystem, so the line
 * shaping (and the per-section `nextStep` surfacing) is only testable
 * once separated from IO. Every section renders its `nextStep` when
 * present — including an `ok` row that still carries advisory guidance
 * (e.g. voice resolved but `MUSE_VOICE_TTS=piper` fell back).
 */
export function formatSetupStatusLines(snap: SetupStatusSnapshot): string[] {
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

  // local-only / no-cloud-egress posture (warn/fail map onto the
  // renderer's info/todo vocabulary; the detail carries the real message)
  push(
    snap.localOnly.status === "ok" ? "ok" : snap.localOnly.status === "warn" ? "info" : "todo",
    "local-only",
    snap.localOnly.detail
  );

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
    push("ok", "voice", `stt=${snap.voice.sttBackend}, tts=${snap.voice.ttsBackend}`);
  } else {
    push("info", "voice", "no provider wired");
  }
  // Advisory even on an `ok` row: a resolved-but-fell-back config
  // (MUSE_VOICE_TTS=piper without MUSE_PIPER_VOICE → paid OpenAI) sets
  // a nextStep with status:ok; surface it instead of swallowing it.
  pushNext(snap.voice.nextStep);

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

  // user memory (auto-extract)
  const um = snap.userMemory;
  if (um.autoExtract) {
    const detail = um.model ? `auto-extract on (model=${um.model})` : "auto-extract on";
    push("ok", "user memory", detail);
  } else {
    push("info", "user memory", "auto-extract disabled");
    pushNext(um.nextStep);
  }

  // proactive surfacing
  const pr = snap.proactive;
  if (pr.enabled) {
    const detail: string[] = [];
    detail.push(`${pr.providerId ?? "?"} → ${pr.destination ?? "?"}`);
    detail.push(`lead=${pr.leadMinutes.toString()}min`);
    detail.push(`tick=${pr.tickMs.toString()}ms`);
    if (pr.agentTurn) detail.push("agent-turn=true");
    if (pr.quietHours) detail.push(`quiet=${pr.quietHours}`);
    push("ok", "proactive", detail.join(", "));
  } else {
    push("info", "proactive", "disabled");
    pushNext(pr.nextStep);
  }

  // reminder firing daemon
  const rm = snap.reminder;
  if (rm.enabled) {
    const detail: string[] = [];
    detail.push(`${rm.providerId ?? "?"} → ${rm.destination ?? "?"}`);
    detail.push(`tick=${rm.tickMs.toString()}ms`);
    if (rm.agentTurn) detail.push("agent-turn=true");
    if (rm.quietHours) detail.push(`quiet=${rm.quietHours}`);
    push("ok", "reminder firing", detail.join(", "));
  } else {
    push("info", "reminder firing", "disabled");
    pushNext(rm.nextStep);
  }

  // actuators (gated state-changing tools, opt-in via `muse ask --actuators`)
  const act = snap.actuators;
  const mark = (ready: boolean): string => (ready ? "✓" : "✗");
  push(
    act.status,
    "actuators",
    `email ${mark(act.email)}, web ${mark(act.web)}, home ${mark(act.home)}`
  );
  pushNext(act.nextStep);

  lines.push("");
  lines.push("Wizards:");
  lines.push("  muse setup wizard      — end-to-end onboarding (model → calendar → messaging)");
  lines.push(`  muse setup model       — LLM provider keys (${providerIdList()})`);
  lines.push("  muse setup calendar    — OAuth / CalDAV / macOS calendar credentials");
  lines.push("  muse setup messaging   — Telegram / Discord / Slack / LINE bot tokens");
  lines.push("  muse mcp config-add    — register an external MCP server");
  lines.push("  muse proactive test    — push a one-line test notice through MUSE_PROACTIVE_PROVIDER");
  lines.push("  muse proactive scan    — dry-run the lead-minutes window across calendar + tasks");
  return lines;
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
