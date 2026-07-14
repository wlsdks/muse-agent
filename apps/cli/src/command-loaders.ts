// Lazy command loaders: each dynamically imports ONLY its own command module
// subtree and registers the real command on first invocation. Keyed so the
// parseAsync wrapper in program.ts loads just the invoked command's graph
// instead of the whole ~100-command tree. To add a command, add its loader
// here AND its stub in command-manifest.ts; coverage + metadata are pinned by
// command-manifest.drift.test.ts.
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export type LazyDeps = Record<string, unknown>;

export interface LazyCommandLoader {
  readonly id: string;
  readonly names: readonly string[];
  readonly load: (program: Command, io: ProgramIO, deps: LazyDeps) => Promise<void>;
}

export const COMMAND_LOADERS: readonly LazyCommandLoader[] = [
  {
    id: "setup",
    names: ["setup"],
    load: async (program, io, _deps) => {
    const m0 = await import("./commands-scheduler-setup.js");
    const m1 = await import("./commands-setup-local.js");
    const m2 = await import("./commands-setup-cloud.js");
    const m3 = await import("./commands-setup-voice.js");
    const m4 = await import("./commands-setup-data.js");
    m0.registerSetupCommands(program, io);
    m1.registerSetupLocalCommand(program, io, _deps as never);
    m2.registerSetupCloudCommand(program, io, _deps as never);
    m3.registerSetupVoiceCommand(program, io);
    m4.registerSetupDataCommand(program, io);
    const { registerSetupStartSubcommand } = await import("./commands-setup-start.js");
    registerSetupStartSubcommand(program, io, _deps);
    },
  },
  {
    id: "notes",
    names: ["notes"],
    load: async (program, io, _deps) => {
    const m0 = await import("./commands-notes.js");
    const m1 = await import("./commands-notes-rag.js");
    m0.registerNotesCommands(program, io, _deps as never);
    m1.registerNotesRagCommands(program, io);
    },
  },
  {
    id: "remember",
    names: ["remember","forget"],
    load: async (program, io, _deps) => {
    const m0 = await import("./commands-remember.js");
    m0.registerRememberCommands(program, io);
    },
  },
  {
    id: "config",
    names: ["config"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-config.js");
    m.registerConfigCommands(program, io, _deps as never);
    },
  },
  {
    id: "auth",
    names: ["auth"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-auth.js");
    m.registerAuthCommands(program, io, _deps as never);
    },
  },
  {
    id: "listen",
    names: ["listen"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-listen.js");
    m.registerListenCommand(program, io, _deps as never);
    },
  },
  {
    id: "mcp",
    names: ["mcp"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-mcp.js");
    m.registerMcpCommands(program, io, _deps as never);
    },
  },
  {
    id: "proactive",
    names: ["proactive"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-proactive.js");
    m.registerProactiveCommands(program, io);
    },
  },
  {
    id: "swarm",
    names: ["swarm"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-swarm.js");
    m.registerSwarmCommands(program, io);
    },
  },
  {
    id: "reflections",
    names: ["reflections"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-reflections.js");
    m.registerReflectionsCommand(program, io);
    },
  },
  {
    id: "models",
    names: ["models"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-models.js");
    m.registerModelsCommand(program, io);
    },
  },
  {
    id: "board",
    names: ["board"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-board.js");
    m.registerBoardCommand(program, io);
    },
  },
  {
    id: "learned",
    names: ["learned"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-learned.js");
    m.registerLearnedCommand(program, io);
    },
  },
  {
    id: "journey",
    names: ["journey"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-journey.js");
    m.registerJourneyCommands(program, io);
    },
  },
  {
    id: "propose",
    names: ["propose"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-propose.js");
    m.registerProposeCommands(program, io);
    },
  },
  {
    id: "daemon",
    names: ["daemon"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-daemon.js");
    m.registerDaemonCommands(program, io);
    },
  },
  {
    id: "skills",
    names: ["skills"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-skills.js");
    m.registerSkillsCommands(program, io);
    },
  },
  {
    id: "agents",
    names: ["agents"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-agents.js");
    m.registerAgentsCommands(program, io);
    },
  },
  {
    id: "ingest",
    names: ["ingest"],
    load: async (program, io, _deps) => {
      const m = await import("./chat-export-ingest.js");
    m.registerIngestCommand(program, io);
    },
  },
  {
    id: "onboard",
    names: ["onboard"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-onboard.js");
    m.registerOnboardCommand(program, io);
    },
  },
  {
    id: "specs",
    names: ["specs"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-specs.js");
    m.registerSpecsCommands(program, io, _deps as never);
    },
  },
  {
    id: "orchestrate",
    names: ["orchestrate"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-orchestrate.js");
    m.registerOrchestrateCommands(program, io, _deps as never);
    },
  },
  {
    id: "calendar",
    names: ["calendar"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-calendar.js");
    m.registerCalendarCommands(program, io, _deps as never);
    },
  },
  {
    id: "memory",
    names: ["memory"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-memory.js");
    m.registerMemoryCommands(program, io, _deps as never);
    },
  },
  {
    id: "messaging",
    names: ["messaging"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-messaging.js");
    m.registerMessagingCommands(program, io, _deps as never);
    },
  },
  {
    id: "remind",
    names: ["remind"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-remind.js");
    m.registerRemindCommands(program, io, _deps as never);
    },
  },
  {
    id: "followup",
    names: ["followup"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-followup.js");
    m.registerFollowupCommands(program, io);
    },
  },
  {
    id: "digest",
    names: ["digest"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-digest.js");
    m.registerDigestCommands(program, io);
    },
  },
  {
    id: "episode",
    names: ["episode"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-episode.js");
    m.registerEpisodeCommands(program, io);
    },
  },
  {
    id: "chats",
    names: ["chats"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-chats.js");
    m.registerChatsCommands(program, io);
    },
  },
  {
    id: "commitments",
    names: ["commitments"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-commitments.js");
    m.registerCommitmentsCommands(program, io);
    },
  },
  {
    id: "checkins",
    names: ["checkins"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-checkins.js");
    m.registerCheckinsCommands(program, io);
    },
  },
  {
    id: "user",
    names: ["user"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-user.js");
    m.registerUserCommands(program, io);
    },
  },
  {
    id: "vetoes",
    names: ["vetoes"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-vetoes.js");
      m.registerVetoesCommands(program, io);
    },
  },
  {
    id: "pattern",
    names: ["pattern"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-pattern.js");
    m.registerPatternCommands(program, io);
    },
  },
  {
    id: "search",
    names: ["search"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-search.js");
    m.registerSearchCommand(program, io);
    },
  },
  {
    id: "find",
    names: ["find"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-find.js");
    m.registerFindCommand(program, io);
    },
  },
  {
    id: "csv",
    names: ["csv"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-csv.js");
    m.registerCsvCommand(program, io);
    },
  },
  {
    id: "logo",
    names: ["logo"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-logo.js");
    m.registerLogoCommand(program, io);
    },
  },
  {
    id: "summarize",
    names: ["summarize"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-summarize.js");
    m.registerSummarizeCommand(program, io);
    },
  },
  {
    id: "on-this-day",
    names: ["on-this-day"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-on-this-day.js");
    m.registerOnThisDayCommand(program, io);
    },
  },
  {
    id: "history",
    names: ["history"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-history.js");
    m.registerHistoryCommand(program, io);
    },
  },
  {
    id: "open",
    names: ["open"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-open.js");
    m.registerOpenCommand(program, io);
    },
  },
  {
    id: "scheduler",
    names: ["scheduler"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-scheduler-setup.js");
    m.registerSchedulerCommands(program, io, _deps as never);
    },
  },
  {
    id: "status",
    names: ["status"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-status.js");
    m.registerStatusCommand(program, io);
    },
  },
  {
    id: "bg",
    names: ["bg"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-background.js");
    m.registerBackgroundCommand(program, io);
    },
  },
  {
    id: "brief",
    names: ["brief"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-brief.js");
    m.registerBriefCommand(program, io);
    },
  },
  {
    id: "recap",
    names: ["recap"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-recap.js");
    m.registerRecapCommand(program, io);
    },
  },
  {
    id: "job",
    names: ["job"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-jobs.js");
    m.registerJobCommands(program, io);
    },
  },
  {
    id: "approval",
    names: ["approval"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-approval.js");
    m.registerApprovalCommands(program, io);
    },
  },
  {
    id: "ask",
    names: ["ask"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-ask.js");
    m.registerAskCommand(program, io);
    },
  },
  {
    id: "demo",
    names: ["demo"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-demo.js");
    m.registerDemoCommand(program, io);
    },
  },
  {
    id: "export",
    names: ["export"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-export.js");
    m.registerExportCommand(program, io);
    },
  },
  {
    id: "import",
    names: ["import"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-import.js");
    m.registerImportCommand(program, io);
    },
  },
  {
    id: "session",
    names: ["session"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-session.js");
    m.registerSessionCommands(program, io);
    },
  },
  {
    id: "metrics",
    names: ["metrics"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-metrics.js");
    m.registerMetricsCommands(program, io, _deps as never);
    },
  },
  {
    id: "maintenance",
    names: ["maintenance"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-maintenance.js");
    m.registerMaintenanceCommand(program, io);
    },
  },
  {
    id: "show",
    names: ["show"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-show.js");
    m.registerShowCommand(program, io);
    },
  },
  {
    id: "weather",
    names: ["weather"],
    load: async (program, io, _deps) => {
      const m = await import("./weather.js");
    m.registerWeatherCommand(program, io);
    },
  },
  {
    id: "privacy",
    names: ["privacy"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-privacy.js");
    m.registerPrivacyCommand(program, io);
    },
  },
  {
    id: "week",
    names: ["week"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-week.js");
    m.registerWeekCommand(program, io);
    },
  },
  {
    id: "time",
    names: ["time"],
    load: async (program, io, _deps) => {
      const m = await import("./timezone.js");
    m.registerTimeCommand(program, io);
    },
  },
  {
    id: "read",
    names: ["read"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-read.js");
    m.registerReadCommand(program, io);
    },
  },
  {
    id: "glance",
    names: ["glance"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-glance.js");
    m.registerGlanceCommand(program, io);
    },
  },
  {
    id: "companion-line",
    names: ["companion-line"],
    load: async (program, io, _deps) => {
      const m = await import("./companion-line.js");
    m.registerCompanionLineCommand(program, io);
    },
  },
  {
    id: "recall",
    names: ["recall"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-recall.js");
    m.registerRecallCommand(program, io);
    },
  },
  {
    id: "note",
    names: ["note"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-note.js");
    m.registerNoteCommand(program, io);
    },
  },
  {
    id: "feeds",
    names: ["feeds"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-feeds.js");
    m.registerFeedsCommand(program, io);
    },
  },
  {
    id: "browsing",
    names: ["browsing"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-browsing.js");
    m.registerBrowsingCommand(program, io);
    },
  },
  {
    id: "persona",
    names: ["persona"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-persona.js");
    m.registerPersonaCommand(program, io);
    },
  },
  {
    id: "watch-folder",
    names: ["watch-folder"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-watch-folder.js");
    m.registerWatchFolderCommand(program, io);
    },
  },
  {
    id: "routine",
    names: ["routine"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-routine.js");
    m.registerRoutineCommand(program, io);
    },
  },
  {
    id: "trust",
    names: ["trust"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-trust.js");
    m.registerTrustCommands(program, io);
    },
  },
  {
    id: "webhook",
    names: ["webhook"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-webhook.js");
    m.registerWebhookCommand(program, io);
    },
  },
  {
    id: "agent-notices",
    names: ["agent-notices"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-agent-notices.js");
    m.registerAgentNoticesCommands(program, io, _deps as never);
    },
  },
  {
    id: "tasks",
    names: ["tasks"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-tasks.js");
    m.registerTasksCommands(program, io, _deps as never);
    },
  },
  {
    id: "attunement",
    names: ["thread", "continue"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-attunement.js");
      m.registerAttunementCommands(program, io);
    },
  },
  {
    id: "objectives",
    names: ["objectives"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-objectives.js");
    m.registerObjectivesCommands(program, io);
    },
  },
  {
    id: "playbook",
    names: ["playbook"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-playbook.js");
    m.registerPlaybookCommands(program, io);
    },
  },
  {
    id: "actions",
    names: ["actions"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-actions.js");
    m.registerActionsCommands(program, io);
    },
  },
  {
    id: "approvals",
    names: ["approvals"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-approvals.js");
    m.registerApprovalsCommands(program, io);
    },
  },
  {
    id: "contacts",
    names: ["contacts"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-contacts.js");
    m.registerContactsCommands(program, io);
    },
  },
  {
    id: "anomaly",
    names: ["anomaly"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-anomaly.js");
    m.registerAnomalyCommand(program, io);
    },
  },
  {
    id: "inbox",
    names: ["inbox"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-inbox.js");
    m.registerInboxCommand(program, io);
    },
  },
  {
    id: "email",
    names: ["email"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-email.js");
    m.registerEmailCommands(program, io);
    },
  },
  {
    id: "web-action",
    names: ["web-action"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-web-action.js");
    m.registerWebActionCommands(program, io);
    },
  },
  {
    id: "home",
    names: ["home"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-home.js");
    m.registerHomeCommands(program, io);
    },
  },
  {
    id: "runs",
    names: ["runs"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-runs.js");
    m.registerRunsCommands(program, io, _deps as never);
    },
  },
  {
    id: "doctor",
    names: ["doctor"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-doctor.js");
    m.registerDoctorCommand(program, io, _deps as never);
    },
  },
  {
    id: "cost",
    names: ["cost"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-cost.js");
    m.registerCostCommands(program, io, _deps as never);
    },
  },
  {
    id: "resume",
    names: ["resume"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-resume.js");
    m.registerResumeCommand(program, io);
    },
  },
  {
    id: "trace",
    names: ["trace"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-trace.js");
    m.registerTraceCommand(program, io);
    },
  },
  {
    id: "traces",
    names: ["traces"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-traces.js");
    m.registerTracesCommands(program, io, _deps as never);
    },
  },
  {
    id: "settings",
    names: ["settings"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-settings.js");
    m.registerSettingsCommands(program, io, _deps as never);
    },
  },
  {
    id: "tools",
    names: ["tools"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-tools-admin.js");
    m.registerToolsAdminCommands(program, io, _deps as never);
    },
  },
  {
    id: "debug",
    names: ["debug"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-debug.js");
    m.registerDebugCommands(program, io, _deps as never);
    },
  },
  {
    id: "telemetry",
    names: ["telemetry"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-telemetry.js");
    m.registerTelemetryCommands(program, io, _deps as never);
    },
  },
  {
    id: "today",
    names: ["today"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-today.js");
    m.registerTodayCommands(program, io, _deps as never);
    },
  },
  {
    id: "voice",
    names: ["voice"],
    load: async (program, io, _deps) => {
      const m = await import("./commands-voice.js");
    m.registerVoiceCommands(program, io, _deps as never);
    },
  },
];

/** name -> loader index, including every top-level name a composite loader owns. */
export const LOADER_BY_NAME: ReadonlyMap<string, LazyCommandLoader> = new Map(
  COMMAND_LOADERS.flatMap((l) => l.names.map((n) => [n, l] as const))
);
