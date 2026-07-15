import { errorMessage, isErrorLike } from "@muse/shared";
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
import { CADENCE_ACCEPTED_FORMS, defaultScheduledJobsFile, FileScheduledJobStore, parseCadence } from "@muse/scheduler";
import {
  classifyDaemonLoopHeartbeat,
  defaultProactiveHeartbeatDir,
  defaultSchedulerPauseFile,
  readFollowups,
  readProactiveHeartbeat,
  readSchedulerPauseState,
  setSchedulerPaused,
  type DaemonLoopHeartbeatVerdict
} from "@muse/stores";
import type { Command } from "commander";

import { DEFAULT_DAEMON_INTERVAL_MS } from "./commands-daemon-loop.js";
import { resolveCliLanguage, t } from "./cli-i18n.js";
import { readConfigStore } from "./program-config.js";
import { runCalendarSetup } from "./setup-calendar.js";
import { runEmailSetup } from "./setup-email.js";
import { runMessagingSetup } from "./setup-messaging.js";
import { runModelSetup, SETUP_MODEL_PROVIDER_SPECS } from "./setup-model.js";
import type { ProgramIO } from "./program.js";

/**
 * A job saved while the daemon is stale/absent will NOT fire — the file
 * store write always succeeds regardless of whether anything is reading
 * it. 3x the daemon's own default tick interval (`DEFAULT_DAEMON_INTERVAL_MS`)
 * gives one missed tick of slack before crying wolf on an otherwise-healthy
 * daemon that happened to tick just before this check ran.
 */
export const SCHEDULER_ADD_DAEMON_STALE_MS = 3 * DEFAULT_DAEMON_INTERVAL_MS;

export interface DaemonLivenessSubject {
  readonly en: string;
  readonly ko: string;
}

const DEFAULT_LIVENESS_SUBJECT: DaemonLivenessSubject = { en: "job", ko: "작업" };

/**
 * Fail-LOUD (not fail-close): the job is already saved by the time this
 * runs, so a stale/absent daemon can't be allowed to silently ship a job
 * the user will never see fire. Pure formatter — takes the classified
 * verdict, returns the exact block to print. Bilingual (EN/KO) per the
 * product's dual-language convention for anything the user reads once and
 * needs to act on immediately.
 */
export function formatDaemonLivenessNotice(
  verdict: DaemonLoopHeartbeatVerdict,
  subject: DaemonLivenessSubject = DEFAULT_LIVENESS_SUBJECT
): string {
  if (verdict.status === "alive") {
    return `Daemon alive — next tick within ~${Math.round(DEFAULT_DAEMON_INTERVAL_MS / 1000).toString()}s.\n`;
  }
  const reason = verdict.status === "stale"
    ? `no daemon-loop heartbeat in the last ${Math.round(SCHEDULER_ADD_DAEMON_STALE_MS / 60_000).toString()} min`
    : "the daemon has never run on this box";
  return [
    "",
    `⚠️  WARNING: this ${subject.en} will NOT fire until \`muse daemon\` is running.`,
    `   (${reason})`,
    "   Run in the foreground now:   muse daemon",
    "   Or install it to always run: muse daemon --install",
    "",
    `⚠️  경고: \`muse daemon\`이 실행 중이어야 이 ${subject.ko}이(가) 실행됩니다. 지금은 실행되지 않습니다.`,
    `   (${verdict.status === "stale" ? `최근 ${Math.round(SCHEDULER_ADD_DAEMON_STALE_MS / 60_000).toString()}분간 데몬 신호 없음` : "이 기기에서 데몬이 실행된 적이 없습니다"})`,
    "   포그라운드로 지금 실행:      muse daemon",
    "   상시 실행으로 설치:          muse daemon --install",
    ""
  ].join("\n");
}

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
  /** Test seam — override the heartbeat dir instead of `defaultProactiveHeartbeatDir(process.env)`. */
  readonly heartbeatDir?: string;
  /** Test seam — injectable clock for the `scheduler add` liveness check. */
  readonly now?: () => Date;
}

/**
 * `add` / `list` / `delete` / `pause` / `resume` / `pause-status` are
 * LOCAL-FIRST: they read/write `~/.muse/scheduled-jobs.json`
 * (`FileScheduledJobStore`) directly, no API server required — this is the
 * product requirement ("no API server, no Postgres, no cron syntax
 * knowledge required"). `create-agent` / `trigger` / `dry-run` /
 * `executions` / `next` stay API-backed: they need either the live agent
 * runtime (`trigger`/`dry-run` actually EXECUTE the job) or execution
 * history the CLI process doesn't hold. When no db is configured, the API
 * server's own `createSchedulerStore` ALSO resolves to the same
 * `FileScheduledJobStore` file (`store-factories.ts`), so a job created via
 * `muse scheduler add` is visible to a running `muse api` too — the split
 * only appears once Postgres is configured, which is the deliberate
 * Kysely-vs-file boundary already documented on `createSchedulerStore`.
 */
export function registerSchedulerCommands(program: Command, io: ProgramIO, helpers: SchedulerSetupHelpers): void {
  const { apiRequest, writeOutput } = helpers;
  const scheduler = program.command("scheduler").description("Manage scheduled jobs");

  scheduler
    .command("add")
    .description("Create a recurring scheduled agent prompt — local file store, no API server required")
    .argument("<prompt...>", `What Muse should do each time this fires, e.g. "오늘 일정 요약해서 보내줘"`)
    .option("--every <cadence>", `Recurrence. Accepted forms: ${CADENCE_ACCEPTED_FORMS.join("; ")}`)
    .option("--name <name>", "Job name (default: derived from the prompt)")
    .option("--deliver <provider:destination>", `Delivery override, e.g. "telegram:12345" (default: the running \`muse daemon\`'s own provider/destination)`)
    .option("--model <model>", "Agent model override (default: the daemon's default model)")
    .option("--disabled", "Create disabled — won't fire until re-enabled")
    .action(async (
      promptParts: readonly string[],
      options: { readonly every?: string; readonly name?: string; readonly deliver?: string; readonly model?: string; readonly disabled?: boolean }
    ) => {
      const prompt = promptParts.join(" ").trim();
      await resolveCliLanguage(process.env, () => readConfigStore(io));
      if (prompt.length === 0 || !options.every || options.every.trim().length === 0) {
        io.stderr(`${t("scheduler.add.usage")}\n`);
        process.exitCode = 1;
        return;
      }
      const cadence = parseCadence(options.every);
      if (isErrorLike(cadence)) {
        io.stderr(`muse scheduler add: ${cadence.message}\n`);
        process.exitCode = 1;
        return;
      }
      const store = new FileScheduledJobStore({ file: defaultScheduledJobsFile() });
      const name = options.name?.trim() || prompt.slice(0, 60);
      try {
        const job = await store.save({
          agentModel: options.model,
          agentPrompt: prompt,
          cronExpression: cadence.cronExpression,
          enabled: options.disabled !== true,
          jobType: "agent",
          name,
          notificationChannelId: options.deliver,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        });
        io.stdout(`Scheduled '${job.name}' (${job.id}) — cron ${job.cronExpression} (${job.timezone}).\n`);
        io.stdout(`Fires via \`muse daemon\` (\`muse daemon --install\` to survive logout). Manage with \`muse scheduler list\` / \`muse scheduler delete ${job.id}\`.\n`);
        // Fail-LOUD, not fail-close: the job is already saved above, so a
        // stale/absent daemon must be surfaced loudly rather than let the
        // user believe it will fire. A --disabled job needs `scheduler
        // resume`/re-enable regardless of daemon state, so the daemon
        // liveness line would be a misleading distraction there — skip it.
        if (job.enabled) {
          const heartbeatDir = helpers.heartbeatDir ?? defaultProactiveHeartbeatDir(process.env);
          const now = helpers.now ?? (() => new Date());
          const heartbeat = await readProactiveHeartbeat(heartbeatDir);
          const verdict = classifyDaemonLoopHeartbeat(heartbeat, { nowMs: now().getTime(), staleMs: SCHEDULER_ADD_DAEMON_STALE_MS });
          io.stdout(formatDaemonLivenessNotice(verdict));
        }
      } catch (cause) {
        io.stderr(`muse scheduler add: ${errorMessage(cause)}\n`);
        process.exitCode = 1;
      }
    });

  scheduler
    .command("list")
    .description("List scheduled jobs (local file store, no API server required)")
    .option("--json", "Emit structured JSON instead of the formatted list")
    .action(async (options: { readonly json?: boolean }) => {
      const store = new FileScheduledJobStore({ file: defaultScheduledJobsFile() });
      const jobs = await store.list();
      if (options.json) {
        writeOutput(io, { jobs });
        return;
      }
      if (jobs.length === 0) {
        io.stdout(`No scheduled jobs. Create one with \`muse scheduler add "<prompt>" --every "<cadence>"\`.\n`);
        return;
      }
      io.stdout(`${jobs.length.toString()} scheduled job(s):\n`);
      for (const job of jobs) {
        const status = job.enabled ? job.lastStatus ?? "pending" : "disabled";
        io.stdout(`  ${job.id}  ${job.name}  cron=${job.cronExpression} (${job.timezone})  [${status}]\n`);
      }
    });

  scheduler
    .command("remove")
    .alias("delete")
    .description("Delete a scheduled job (local file store, no API server required)")
    .argument("<job-id>", "Job ID (see `muse scheduler list`)")
    .action(async (jobId: string) => {
      const store = new FileScheduledJobStore({ file: defaultScheduledJobsFile() });
      const existing = await store.findById(jobId);
      if (!existing) {
        io.stderr(`muse scheduler remove: no job with id '${jobId}' (run \`muse scheduler list\`)\n`);
        process.exitCode = 1;
        return;
      }
      await store.delete(jobId);
      io.stdout(`Deleted scheduled job '${existing.name}' (${jobId}).\n`);
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

  scheduler
    .command("pause")
    .description("Pause autonomous scheduled jobs (a running daemon honors it; manual triggers still run)")
    .action(async () => {
      await setSchedulerPaused(defaultSchedulerPauseFile(), true, new Date().toISOString());
      io.stdout("Scheduler paused — autonomous jobs will not fire until `muse scheduler resume`.\n");
    });

  scheduler
    .command("resume")
    .description("Resume autonomous scheduled jobs")
    .action(async () => {
      await setSchedulerPaused(defaultSchedulerPauseFile(), false);
      io.stdout("Scheduler resumed — autonomous jobs will fire on schedule again.\n");
    });

  scheduler
    .command("pause-status")
    .description("Show whether autonomous scheduled jobs are paused")
    .action(async () => {
      const state = await readSchedulerPauseState(defaultSchedulerPauseFile());
      io.stdout(state.paused ? `Paused${state.since ? ` since ${state.since}` : ""}.\n` : "Running (not paused).\n");
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
  setup.addHelpText("after", `
Examples:
  $ muse setup                          # configuration health-check (model, calendar, notes, voice…)
  $ muse setup start                    # first-run wizard — "how should Muse think?"
  $ muse setup data                     # connect Apple Contacts / browsing history (opt-in)
  $ muse setup cloud --provider gemini  # opt out of local-only, use a cloud model (BYO key)`);

  setup
    .command("status", { isDefault: true })
    .description("Print a configuration health-check (model, MCP, calendar, notes, tasks, voice, messaging, email, remote, web search)")
    .option("--json", "Emit structured JSON instead of the formatted status report")
    .action(async (options: { readonly json?: boolean }) => {
      if (options.json) {
        const snapshot = await collectSetupStatusJson();
        io.stdout(`${JSON.stringify(snapshot, null, 2)}\n`);
        return;
      }
      io.stdout(await renderSetupStatus(io));
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
    .command("email")
    .description("Connect Gmail via guided OAuth (browser consent) — the access token refreshes itself after")
    .action(async () => {
      const result = await runEmailSetup(io);
      if (!result.ok) {
        process.exitCode = 1;
      }
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
export async function runSetupWizard(io: { stderr(line: string): void; stdout(line: string): void }): Promise<void> {
  io.stdout("\n");
  io.stdout("─── Muse setup wizard ────────────────────────────\n");
  io.stdout("Three steps: model → calendar → messaging.\n");
  io.stdout("You can stop at any step and resume with `muse setup <area>` later.\n");
  io.stdout("\n");

  io.stdout("[1/3] Model provider\n");
  io.stdout("─────────────────────\n");
  await runModelSetup(io);
  io.stdout("\n");

  io.stdout("[2/3] Calendar\n");
  io.stdout("─────────────────\n");
  await runCalendarSetup(io);
  io.stdout("\n");

  io.stdout("[3/3] Messaging\n");
  io.stdout("──────────────────\n");
  await runMessagingSetup(io);
  io.stdout("\n");

  io.stdout("──── Wizard complete ────\n");
  io.stdout("Run `muse setup` (no args) to verify the final health-check report.\n");
  io.stdout("\n");
}

async function renderSetupStatus(io: ProgramIO): Promise<string> {
  // Single source of truth: format the same snapshot the REST + web
  // surfaces consume, so the per-section guidance under each [todo]/
  // [info] row matches the `nextStep` strings the snapshot owns.
  // Without this, the text renderer drifts from the structured
  // shape every time someone touches a wizard wording.
  const snap = await collectSetupStatusJson();
  const lines = formatSetupStatusLines(snap);
  // Spliced right after the header (index 0) rather than appended at the
  // end — the end sits past `formatSetupStatusLines`'s own "Wizards:"
  // footer, where a status row would read as an afterthought.
  lines.splice(1, 0, await languageStatusLine(io));
  return `${lines.join("\n")}\n`;
}

/**
 * AC1's "language row" — outside `formatSetupStatusLines` (which is
 * pure over the shared `SetupStatusSnapshot` from `@muse/autoconfigure`)
 * because the language config lives in the CLI's own `config.json`, not
 * that cross-surface snapshot. `source` names WHERE the resolved value
 * came from (env override wins, then config, then OS-locale auto-detect)
 * so a user confused about why the language is what it is can see why.
 */
export async function languageStatusLine(io: ProgramIO): Promise<string> {
  const config = await readConfigStore(io);
  const envLang = process.env.MUSE_LANG?.trim().toLowerCase();
  const source = envLang === "ko" || envLang === "en" ? "env" : config.language ? "config" : "auto-detected";
  const lang = await resolveCliLanguage(process.env, () => Promise.resolve(config));
  return `  [ok]   language — ${t("setup.status.language", { lang, source })}`;
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

  // model — always name the resolved model + where it came from, so a
  // local-first box (no MUSE_MODEL, no cloud key) reads a real value, not a
  // blank detail. Mirrors `doctor`'s resolver (setup-status.buildModelSection).
  if (snap.model.status === "ok") {
    const detail: string[] = [];
    if (snap.model.resolvedModel) {
      // Env stays as `MUSE_MODEL=<model>` (truthful — the var IS set); other
      // sources name the model + where it came from so the detail is never blank.
      detail.push(
        snap.model.modelSource === "env"
          ? `MUSE_MODEL=${snap.model.resolvedModel}`
          : `${snap.model.resolvedModel} (${
            snap.model.modelSource === "config" ? "from config"
              : snap.model.modelSource === "cloud" ? "inferred from cloud key"
                : "local default"
          })`
      );
    }
    if (snap.model.providerKeys.length > 0) {
      detail.push(`${snap.model.providerKeys.length.toString()} provider key(s): ${snap.model.providerKeys.join(", ")}`);
    }
    push("ok", "model", detail.join(", "));
    pushNext(snap.model.nextStep);
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

  // email
  if (snap.email.source === "oauth") {
    push("ok", "email", "connected (oauth, auto-refresh)");
  } else if (snap.email.source === "imap") {
    push("ok", "email", "connected (app password, IMAP)");
  } else if (snap.email.source === "env") {
    push("ok", "email", "via MUSE_GMAIL_TOKEN (hourly expiry)");
  } else {
    push("info", "email", "not set up");
  }
  pushNext(snap.email.nextStep);

  // remote (tailscale)
  if (snap.remote.tailscaleFound) {
    push("ok", "remote", "tailscale found");
  } else {
    push("info", "remote", "not found");
  }
  pushNext(snap.remote.nextStep);

  // daily brief (muse setup briefing — fixed-time morning digest)
  if (snap.dailyBrief.enabled) {
    push("ok", "daily brief", `enabled, ${snap.dailyBrief.time ?? "08:30"} local`);
  } else {
    push("info", "daily brief", "not set up");
  }
  pushNext(snap.dailyBrief.nextStep);

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

