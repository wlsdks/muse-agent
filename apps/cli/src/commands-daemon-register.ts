import { errorMessage } from "@muse/shared";
/**
 * `muse daemon` — run Muse's background daemons in one foreground
 * process the user can launch directly, instead of needing the full
 * `apps/api` server. It drives the proactive-notice tick;
 * additional ticks (followup / objectives / ambient / web-watch)
 * attach to the same launcher.
 *
 *   muse daemon          — run continuously, one tick per interval
 *   muse daemon --once   — run exactly one tick of each enabled
 *                          daemon, then exit (no infinite loop, no
 *                          process.exit — the testable seam)
 */

import type { Command } from "commander";

import {
  buildCalendarRegistry,
  buildMessagingRegistry,
  backgroundModelExecutionBudgetEnvironment,
  createMessagingPollDispatchers,
  parseBoolean,
  parseNonNegativeInteger,
  resolveDigestQueueFile,
  resolveDigestSentFile,
  resolveFollowupsFile,
  resolveInterruptionLedgerFile,
  resolveLastProactiveDeliveryFile,
  resolveActionLogFile,
  resolveIntegrationEnvironment,
  resolveMuseCliConfigFilePath,
  resolveNotesDir,
  resolveObjectivesFile,
  resolveProactiveHistoryFile,
  resolveReconfirmCardAnsweredFile,
  resolveReconfirmCardDeliveryFile,
  resolveRemindersFile,
  resolveTasksFile,
  resolveHomeAssistantEnvironment,
  type DecayContradictedDeps,
  type DistillQueuedDeps
} from "@muse/autoconfigure";
import type { MessagingProviderRegistry } from "@muse/messaging";
import { isLocalOnlyEnabled } from "@muse/model";
import { defaultScheduledJobsFile } from "@muse/scheduler";
import { defaultProactiveHeartbeatDir, defaultSchedulerPauseFile, queryActionLog, readQuietHoursSettingSync, readReminders, readTasks, recordProactiveHeartbeat, resolveDaemonSettingsFile } from "@muse/stores";
import { createAmbientNoticeRunner, createMessagingObjectiveActuator, createModelObjectiveEvaluator, createProposingObjectiveActuator, createWebWatchRunner, FileAmbientSignalSource, gateProactiveNoticeSink, resolveEffectiveQuietHours, MacOsActiveWindowSource, parseAmbientNoticeRules, WindowsActiveWindowSource, webWatchesFromConfig, type AmbientNoticeRunner, type BriefingCalendarLister, type ChromeSnapshotConnection, type InterruptionBudgetWiring, type ProactiveNoticeSink, type QuietHourRange, type WebWatchRunner } from "@muse/proactivity";
import { homeWatchesFromConfig, type EmailProvider } from "@muse/domain-tools";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";

// node:child_process has no /promises submodule (unlike fs/timers) — a
// phantom import of it has now broken the build twice; the regression
// lock lives in no-phantom-node-modules.test.ts.
const execFile = promisify(execFileCallback);
import { buildLaunchAgentPlist, LAUNCH_AGENT_LABEL, parseLaunchctlListInfo, resolveLaunchAgentFile } from "./commands-daemon-launchagent.js";
import {
  defaultDaemonTemporaryRoots,
  formatDaemonAutostartStatus,
  inspectDaemonAutostart,
  parseLaunchAgentEnvironmentVariables,
  validateDaemonCliEntry,
  type DaemonAutostartStatus
} from "./commands-daemon-autostart.js";
import { buildSchtasksCreateArgs, buildSchtasksDeleteArgs, buildSchtasksQueryArgs, SCHTASKS_TASK_NAME } from "./commands-daemon-schtasks.js";
import { readDaemonConfig, resolveDaemonConfigFile, writeDaemonConfig } from "./commands-daemon-config.js";
import { dirname, join } from "node:path";

import { autoReindexBudgetEnvironment } from "./auto-reindex-budget.js";
import { closestCommandName } from "./closest-command.js";
import { resolveCliLanguage, t } from "./cli-i18n.js";
import { readConfigStore } from "./program-config.js";
import { parseBoundedFlag } from "./commands-proactive.js";
import { DEFAULT_REFLECTION_INTERVAL_MS } from "./commands-reflections.js";
import {
  makeDigestFlushTick,
  makeMemoryConsolidateTick,
  makePlaybookConsolidateTick,
  makeRecapTick,
  makeSelfLearnDecayTick,
  makeSelfLearnTick,
  type TickRunState
} from "./daemon-selflearn-ticks.js";
import {
  makeAmbientTick,
  makeBrowsingAutoSyncTick,
  makeConflictWatchTick,
  makeEmailSyncTick,
  makeHomeWatchTick,
  makeMessagingPollTick,
  makeObjectivesTick,
  makeWebWatchTick
} from "./daemon-watch-ticks.js";
import {
  makeBackgroundExitNoticeTick,
  makeBriefingTick,
  makeCheckinsTick,
  makeDailyBriefTick,
  makeFollowupTick,
  makePatternTick,
  makeProactiveTick,
  makeRemindersTick,
  makeReflectionTick,
  makeRetentionPruneTick,
  makeSchedulerTick
} from "./daemon-delivery-ticks.js";
import type { ProgramIO } from "./program.js";
import { isGmailConfigured } from "./resolve-gmail-provider.js";
import { DaemonStopSignal, DEFAULT_DAEMON_INTERVAL_MS, runDaemonLoop } from "./commands-daemon-loop.js";
import { defaultChromeConnection, defaultFollowupModel, defaultKnowledgeEnrich, type FollowupModel } from "./commands-daemon-connections.js";
import { lockDaemonMessagingRegistry, resolveDaemonProviderLock, type DaemonProviderLock } from "./daemon-messaging-safety.js";
import { assessDaemonResourceAdmission, daemonResourcePolicyEnvironment, readDaemonResourceSnapshot, type DaemonResourceSnapshot } from "./daemon-resource-admission.js";
import { resolveDaemonHeavyWorkUnitsPerTick } from "./daemon-heavy-work-budget.js";
import { cancelledDecisionReceipt, resolveDaemonResourceReceiptFile, withWorkloadBoundary, workloadDecisionReceipt, writeDaemonResourceAdmissionReceipt, type DaemonResourceReceipt, type DaemonWorkloadUnitId } from "./daemon-resource-receipt.js";
import { DaemonWorkloadGovernor, daemonWorkloadNotReady, type DaemonWorkloadCycleResult } from "./daemon-workload-governor.js";
import { emptyDaemonWorkloadProfile, readDaemonWorkloadProfile, recordDaemonWorkloadReceipt, resolveDaemonWorkloadProfileFile, writeDaemonWorkloadProfile } from "./daemon-workload-profile.js";

const DEFAULT_INTERRUPTION_HOURLY_CAP = 2;
const DEFAULT_INTERRUPTION_DAILY_CAP = 6;

/**
 * The proactive-trust ledger file — shared by the proactive-notice tick's
 * daily cap AND the channel-veto avoided-source check every UNASKED loop
 * consults (`resolveInterruptionBudgetWiring` below). One resolver, one
 * source of truth, mirroring `apps/api/src/tick-daemons.ts`'s
 * `resolveProactiveTrustFile`.
 */
/**
 * Live quiet-hours resolver for `muse daemon`'s continuous process — mirrors
 * `apps/api/src/tick-daemons.ts`'s `liveQuietHours`: per-loop env, then the
 * shared base env, then the persisted setting (`@muse/stores`'s
 * daemon-settings file, PATCHed from web Settings / set via `muse quiet`).
 * Re-reads the persisted file on every call so a change takes effect on the
 * daemon's very next tick, no restart. Not used by `makeRemindersTick` /
 * `makeDailyBriefTick` — those stay exempt from quiet hours.
 */
export function liveQuietHours(
  e: NodeJS.ProcessEnv,
  io: ProgramIO,
  perLoopVar: string | undefined,
  baseVar: string | undefined
): () => QuietHourRange | undefined {
  const settingsFile = resolveDaemonSettingsFile(e);
  let warned = false;
  return () => resolveEffectiveQuietHours({
    baseEnvRaw: baseVar,
    onInvalidPersisted: (raw) => {
      if (!warned) {
        warned = true;
        io.stderr(`quiet-hours: ignoring invalid persisted range "${raw}"\n`);
      }
    },
    perLoopEnvRaw: perLoopVar,
    persisted: readQuietHoursSettingSync(settingsFile)
  });
}

export function resolveProactiveTrustFile(e: NodeJS.ProcessEnv): string {
  if (e.MUSE_PROACTIVE_TRUST_FILE?.trim()?.length) return e.MUSE_PROACTIVE_TRUST_FILE.trim();
  // HOME-first: os.homedir() ignores $HOME on win32 (USERPROFILE), breaking
  // HOME-based isolation and drifting from the api tick's resolver.
  const home = e.HOME?.trim() || process.env.HOME?.trim();
  return join(home && home.length > 0 ? home : homedir(), ".muse", "proactive-trust.json");
}

/**
 * The shared interruption budget every UNASKED notice tick (pattern /
 * ambient / followup / background-exit / checkins) opts into. Always
 * returned (never gated behind its own flag) so a delivery is ledgered
 * even when both caps are disabled (`<= 0` → unlimited, per
 * `withinInterruptionBudget`) — see `apps/api/src/tick-daemons.ts`'s
 * matching resolver for the server-side counterpart.
 *
 * `trustLedgerFile` + `lastDeliveryFile` complete the channel-veto loop: each
 * loop re-reads `trustLedgerFile`'s avoided-source set once per tick (fresh —
 * a veto recorded mid-run takes effect on the very next tick, no restart),
 * and a delivered/digested notice's sourceKey is recorded to
 * `lastDeliveryFile` so a later "stop"/"그만" reply can resolve what to veto.
 */
export function resolveInterruptionBudgetWiring(e: NodeJS.ProcessEnv): InterruptionBudgetWiring {
  return {
    dailyCap: parseNonNegativeInteger(e.MUSE_INTERRUPTION_DAILY_CAP, DEFAULT_INTERRUPTION_DAILY_CAP),
    digestFile: resolveDigestQueueFile(e),
    hourlyCap: parseNonNegativeInteger(e.MUSE_INTERRUPTION_HOURLY_CAP, DEFAULT_INTERRUPTION_HOURLY_CAP),
    lastDeliveryFile: resolveLastProactiveDeliveryFile(e),
    ledgerFile: resolveInterruptionLedgerFile(e),
    trustLedgerFile: resolveProactiveTrustFile(e)
  };
}

export interface DaemonHelpers {
  /** Test seam — defaults to `process.env`. */
  readonly env?: () => NodeJS.ProcessEnv;
  /**
   * Test seam — inject a contract-faithful messaging registry rather
   * than building one from env, so a smoke can assert delivery against
   * a capturing fake provider.
   */
  readonly buildMessagingRegistry?: (env: NodeJS.ProcessEnv) => MessagingProviderRegistry;
  /** Test seam proving the delivery brake runs before calendar-provider construction. */
  readonly buildCalendarRegistry?: typeof buildCalendarRegistry;
  /** Test seam proving the delivery brake runs before daemon-config reads. */
  readonly readDaemonConfig?: typeof readDaemonConfig;
  /**
   * Test seam — fully resolve the model the followup tick synthesizes
   * with, instead of building the runtime assembly (which reads the
   * real env). Tests inject a fake model or `undefined` (skip).
   */
  readonly resolveFollowupModel?: (env: NodeJS.ProcessEnv) => Promise<FollowupModel | undefined>;
  /**
   * Test seam — resolves the optional local knowledge runtime only after the
   * resource governor admits heavy work.  Keeping this as a resolver (rather
   * than injecting a ready enrich function) proves a paused daemon does not
   * start an embedder just to remain resident.
   */
  readonly resolveKnowledgeEnrich?: typeof defaultKnowledgeEnrich;
  /** Test seam — inject the fetch the web-watch tick snapshots with. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Test seam — inject the osascript runner for the macOS ambient source. */
  readonly ambientMacosRun?: (script: string) => Promise<string | undefined>;
  /**
   * Chrome DevTools MCP connection for `source:"chrome"` web-watches.
   * Without one, chrome-source watches are skipped (fail-soft) and the
   * daemon stays up. Tests inject a contract-faithful fake.
   */
  readonly chromeConnection?: ChromeSnapshotConnection;
  /** Test seam — resolves the optional Chrome DevTools connection on admission. */
  readonly resolveChromeConnection?: typeof defaultChromeConnection;
  /**
   * Knowledge enricher for the ambient tick — given what the user is
   * looking at, returns a "Related: …" line from their own notes so an
   * ambient notice carries relevant context. Absent → no enrichment.
   */
  readonly knowledgeEnrich?: (query: string) => Promise<string | undefined> | string | undefined;
  /** Test seam — inject the calendar lister the briefing's imminent uses. */
  readonly briefingCalendarLister?: BriefingCalendarLister;
  /**
   * Test seam — inject the distiller the self-learning tick turns a queued
   * correction into a strategy with, so a smoke can assert an unattended
   * distill (and the brake) without a live LLM. Absent → the real local-Qwen
   * distiller (an `undefined` return ⇒ no strategy written, the grounding fence).
   */
  readonly selfLearnDistill?: DistillQueuedDeps["distill"];
  /**
   * Test seam — inject the correction-vs-strategy polarity classifier the
   * autonomous SUBTRACTIVE correction-decay uses, so a smoke can drive the decay
   * (a NEW correction that CONTRADICTS an injected strategy drops it below the
   * inject line) without a live LLM. Absent → the real model-backed classifier.
   */
  readonly contradictionClassify?: DecayContradictedDeps["classify"];
  /**
   * Test seam — inject the email source the continuous email-sync tick reads, so a
   * smoke can drive Gmail→notes ingestion (a contract-faithful real GmailEmailProvider
   * with a fake fetch) without a live Gmail round-trip. Absent → the real provider
   * built from MUSE_GMAIL_TOKEN.
   */
  readonly emailSyncProvider?: Pick<EmailProvider, "listRecent">;
  /** Test seam for proving the Gmail-specific factory is never entered. */
  readonly makeEmailSyncTick?: typeof makeEmailSyncTick;
  /** Test seam for the continuous loop; production uses the real runner. */
  readonly runDaemonLoop?: typeof runDaemonLoop;
  /**
   * Test seams — inject the LLM merge + the held-out coverage validator the
   * autonomous playbook-consolidate tick uses, so a smoke can drive a real
   * merge of near-duplicate PROBATION strategies (and the safety contract:
   * merged stays on probation, never graduates) without a live LLM/embedder.
   */
  readonly consolidateMerge?: (texts: readonly string[]) => Promise<string | undefined>;
  readonly consolidateValidate?: (originals: readonly string[], merged: string) => Promise<{ readonly accept: boolean; readonly reason: string; readonly lost?: readonly string[] }>;
  /**
   * Test seam — inject the messaging poll so a smoke can assert the daemon
   * pulls new inbound (which the inbox-injection cursor then makes recallable)
   * without a live Telegram/Discord/Slack round-trip. Absent → the real
   * `createMessagingPollDispatchers(env, registry).pollAll`.
   */
  readonly messagingPoll?: () => Promise<{
    readonly ingestedByProvider: Readonly<Record<string, number>>;
    readonly errors: readonly { readonly providerId: string; readonly message: string }[];
  }>;
  /**
   * Test seam — inject the calendar lister the conflict-watch tick scans, so a
   * smoke can drive a proactive double-booking notice (and the dedup contract:
   * the same clash notifies ONCE across ticks) without a real calendar provider.
   * Absent → the registered calendar provider's `listEvents`.
   */
  readonly conflictWatchCalendarLister?: (range: { readonly from: Date; readonly to: Date }) => Promise<readonly { readonly title: string; readonly startsAt: Date; readonly endsAt: Date; readonly allDay?: boolean }[]>;
  /**
   * Test seam — inject the browsing-history sync the opt-in auto-sync tick runs,
   * so a smoke can assert the CONSENT contract (the default performs ZERO Chrome
   * access) and the opted-in sync without touching a real Chrome file. This seam
   * is the ONLY path that locates + reads the Chrome history, so a spy on it that
   * is never called proves the gate held. Absent → the real locate + sync.
   */
  readonly browsingSync?: (args: { readonly env: NodeJS.ProcessEnv; readonly storeFile: string; readonly limit: number }) => Promise<{ readonly synced: number; readonly total: number }>;
  /** Test seam for local resource admission; absent uses lightweight OS counters. */
  readonly resourceSnapshot?: () => DaemonResourceSnapshot;
  /** Best-effort latest-state receipt for resource admission transitions. */
  readonly writeResourceAdmissionReceipt?: (file: string, receipt: DaemonResourceReceipt) => Promise<void>;
  /** Test seam — runs `schtasks` with an argv array on the win32 --install/--status/--uninstall branches. */
  readonly schtasksRun?: (args: readonly string[]) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  /**
   * Test seam — runs `launchctl` with an argv array on the darwin
   * --install/--uninstall branches. Defaults to a real `execFile("launchctl", …)`.
   * Injected by tests so `--install`/`--uninstall` can be proven WITHOUT ever
   * touching the real user's launchd — the hard boundary for this seam.
   */
  readonly runLaunchctl?: (args: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
  /** Test seam — platform override for the --install / --status / --uninstall autostart branches. */
  readonly platform?: NodeJS.Platform;
  /** Test seam — production persists process.argv[1] after stable-entry validation. */
  readonly daemonCliEntry?: string;
  /** Test seam — deterministic temporary-root classification across operating systems. */
  readonly daemonTemporaryRoots?: readonly string[];
}

/**
 * True inside a vitest worker. Both defaults below check this BEFORE
 * shelling out — a test that forgets to inject `schtasksRun`/`runLaunchctl`
 * must fail loudly instead of actually registering a scheduled task or
 * loading a real launchd job on the machine running the suite.
 */
function isRunningUnderVitest(): boolean {
  return (process.env.VITEST ?? "").trim().length > 0 || process.env.VITEST_WORKER_ID !== undefined;
}

const defaultSchtasksRun = async (args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  if (isRunningUnderVitest()) {
    throw new Error(
      `refusing to exec real schtasks under vitest (args: ${args.join(" ")}) — inject DaemonHelpers.schtasksRun in this test`
    );
  }
  try {
    const result = await execFile("schtasks", [...args], { timeout: 15_000 });
    return { exitCode: 0, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch (cause: unknown) {
    return {
      exitCode: normalizeExecFileCode(cause),
      stdout: extractOutputFromExecError(cause, "stdout").toString(),
      stderr: extractOutputFromExecError(cause, "stderr").toString()
    };
  }
};

/**
 * NEVER reaches real launchctl under vitest, even if a test forgets to
 * inject `runLaunchctl` — the hard boundary this seam exists to guarantee
 * (see the header comment on `DaemonHelpers.runLaunchctl`). Loading a real
 * LaunchAgent from a test run would leave a KeepAlive daemon resident on the
 * contributor's machine.
 */
const defaultRunLaunchctl = async (args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
  if (isRunningUnderVitest()) {
    throw new Error(
      `refusing to exec real launchctl under vitest (args: ${args.join(" ")}) — inject DaemonHelpers.runLaunchctl in this test`
    );
  }
  try {
    const result = await execFile("launchctl", [...args], { timeout: 15_000 });
    return { code: 0, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch (cause: unknown) {
    return {
      code: normalizeExecFileCode(cause),
      stdout: extractOutputFromExecError(cause, "stdout").toString(),
      stderr: extractOutputFromExecError(cause, "stderr").toString()
    };
  }
};

function normalizeExecFileCode(cause: unknown): number {
  const rawCode = (cause as { code?: number | string } | undefined)?.code;
  if (typeof rawCode === "number") return rawCode;
  if (typeof rawCode === "string") {
    const parsed = Number(rawCode);
    return Number.isFinite(parsed) ? parsed : 1;
  }
  return 1;
}

function extractOutputFromExecError(cause: unknown, key: "stdout" | "stderr"): string | Buffer {
  if (cause && typeof cause === "object" && key in cause) {
    const value = (cause as Record<"stdout" | "stderr", string | Buffer | undefined>)[key];
    if (value !== undefined) return value;
  }
  return "";
}

/** One source of truth for daemon status and Doctor: artifact and runtime stay separate. */
export async function getDaemonAutostartStatus(
  e: NodeJS.ProcessEnv,
  helpers: Pick<DaemonHelpers, "platform" | "runLaunchctl" | "schtasksRun"> = {}
): Promise<DaemonAutostartStatus> {
  const platform = helpers.platform ?? process.platform;
  return inspectDaemonAutostart({
    launchAgentLabel: LAUNCH_AGENT_LABEL,
    platform,
    plistFile: resolveLaunchAgentFile(e),
    ...(helpers.runLaunchctl
      ? { runLaunchctl: helpers.runLaunchctl }
      : isRunningUnderVitest()
        ? {}
        : { runLaunchctl: defaultRunLaunchctl }),
    scheduledTaskName: SCHTASKS_TASK_NAME,
    schtasksQueryArgs: buildSchtasksQueryArgs,
    ...(helpers.schtasksRun
      ? { schtasksRun: helpers.schtasksRun }
      : isRunningUnderVitest()
        ? {}
        : { schtasksRun: defaultSchtasksRun })
  });
}

interface DaemonStatusSafetyGates {
  readonly deliveryBrakeEngaged: boolean;
  readonly providerLock: DaemonProviderLock | undefined;
  readonly selfLearningEnabled: boolean;
  readonly source: "resident LaunchAgent" | "current shell/default";
}

/**
 * Status is often run from an interactive shell after a reboot, while the
 * resident daemon gets only its plist environment. When a valid artifact is
 * present, resolve these three safety gates from that contained environment —
 * never inherit a shell override for an absent plist key.
 */
function resolveDaemonStatusSafetyGates(
  shellEnv: NodeJS.ProcessEnv,
  autostart: DaemonAutostartStatus
): DaemonStatusSafetyGates {
  if (autostart.kind === "darwin" && autostart.artifact.state === "valid") {
    try {
      const variables = parseLaunchAgentEnvironmentVariables(readFileSync(autostart.plistFile, "utf8"));
      if (variables !== undefined) {
        const providerLock = variables.MUSE_DAEMON_PROVIDER_LOCK?.trim();
        return {
          deliveryBrakeEngaged: !parseBoolean(variables.MUSE_DAEMON_DELIVERY_ENABLED, true),
          providerLock: providerLock === "log" ? "log" : undefined,
          selfLearningEnabled: parseBoolean(variables.MUSE_SELFLEARN_ENABLED, true),
          source: "resident LaunchAgent"
        };
      }
    } catch {
      // A valid artifact may disappear between the service-manager and file
      // probes. Fall back visibly instead of inventing contained values.
    }
  }
  return {
    deliveryBrakeEngaged: !parseBoolean(shellEnv.MUSE_DAEMON_DELIVERY_ENABLED, true),
    providerLock: resolveDaemonProviderLock(shellEnv),
    selfLearningEnabled: parseBoolean(shellEnv.MUSE_SELFLEARN_ENABLED, true),
    source: "current shell/default"
  };
}

/**
 * Resource policy is part of the resident contract too. A valid LaunchAgent
 * must shadow the invoking shell even when it omits this key (omission means
 * the documented unbounded default), otherwise status could advertise a cap
 * the already-running daemon never received.
 */
function resolveDaemonStatusHeavyWorkUnitsPerTick(
  shellEnv: NodeJS.ProcessEnv,
  autostart: DaemonAutostartStatus
): number {
  if (autostart.kind === "darwin" && autostart.artifact.state === "valid") {
    try {
      const variables = parseLaunchAgentEnvironmentVariables(readFileSync(autostart.plistFile, "utf8"));
      if (variables !== undefined) {
        return resolveDaemonHeavyWorkUnitsPerTick({
          MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: variables.MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK
        });
      }
    } catch {
      // Fall through to the current shell/default when the artifact vanishes.
    }
  }
  return resolveDaemonHeavyWorkUnitsPerTick(shellEnv);
}

/**
 * The core of `muse daemon --install`: write + load a macOS LaunchAgent, or
 * register a Windows scheduled task, through the SAME injected runner seams
 * `registerDaemonCommands` uses (never real launchctl/schtasks under vitest —
 * `defaultRunLaunchctl`/`defaultSchtasksRun` already guarantee that). Split
 * out so `muse onboard`'s background-daemon offer can drive the identical
 * install path without duplicating the launchd/schtasks logic. Returns
 * `{ok:false}` (never throws) on every failure branch, incl. an unsupported
 * platform — the caller decides what a failure means for it (exit code vs.
 * a fail-soft manual-command hint).
 */
export async function installDaemonAutostart(
  io: ProgramIO,
  e: NodeJS.ProcessEnv,
  helpers: Pick<DaemonHelpers, "daemonCliEntry" | "daemonTemporaryRoots" | "platform" | "runLaunchctl" | "schtasksRun"> = {}
): Promise<{ readonly ok: boolean }> {
  const plat = helpers.platform ?? process.platform;
  if (plat !== "darwin" && plat !== "win32") {
    io.stderr(`muse daemon --install is only wired for macOS (launchd) and Windows (schtasks) — this platform reports '${plat}'. Run \`muse daemon\` directly in the foreground, or use your OS's own service manager to keep it resident.\n`);
    return { ok: false };
  }

  // argv[1] is the Muse CLI JavaScript entry at runtime. It is only safe to
  // persist after proving it exists outside OS temporary roots; otherwise a
  // one-off dev runner creates a LaunchAgent that dies after the temp tree is
  // cleaned (the exact stale /private/tmp failure this gate prevents).
  const validatedEntry = validateDaemonCliEntry(helpers.daemonCliEntry ?? process.argv[1], {
    temporaryRoots: helpers.daemonTemporaryRoots ?? defaultDaemonTemporaryRoots(e)
  });
  if (!validatedEntry.ok) {
    io.stderr(`refusing to install daemon autostart: ${validatedEntry.reason}. Run \`muse daemon --install\` from a stable installed Muse CLI, not a temporary dev runner.\n`);
    return { ok: false };
  }
  const cliEntry = validatedEntry.entrypoint;
  if (plat === "win32") {
    const run = helpers.schtasksRun ?? defaultSchtasksRun;
    const result = await run(buildSchtasksCreateArgs({
      programArguments: [process.execPath, cliEntry, "daemon"],
      taskName: SCHTASKS_TASK_NAME
    }));
    if (result.exitCode === 0) {
      io.stdout(`muse daemon registered as scheduled task '${SCHTASKS_TASK_NAME}' (runs at logon)\n  remove with:  muse daemon --uninstall\n`);
      return { ok: true };
    }
    io.stderr(`schtasks failed (exit ${result.exitCode.toString()}): ${result.stderr.trim() || result.stdout.trim()}\n`);
    return { ok: false };
  }
  const plistFile = resolveLaunchAgentFile(e);
  const home = e.HOME?.trim()?.length ? e.HOME.trim() : homedir();
  const logDir = join(home, ".muse", "logs");
  // launchd does not inherit the invoking shell's environment reliably, and
  // KeepAlive restarts happen long after that shell is gone. Persist only the
  // explicit safety switches needed for a controlled local activation.
  // This is intentionally an allowlist: provider credentials, model keys,
  // arbitrary MUSE_* paths, and every other ambient value stay out of plist.
  const safetyEnvironment: Record<string, string> = {};
  let providerLock: ReturnType<typeof resolveDaemonProviderLock>;
  try {
    providerLock = resolveDaemonProviderLock(e);
  } catch {
    io.stderr("refusing to install daemon autostart: MUSE_DAEMON_PROVIDER_LOCK must be unset or 'log'.\n");
    return { ok: false };
  }
  if (isLocalOnlyEnabled(e)) safetyEnvironment.MUSE_LOCAL_ONLY = "true";
  if (!parseBoolean(e.MUSE_SELFLEARN_ENABLED, true)) {
    safetyEnvironment.MUSE_SELFLEARN_ENABLED = "false";
  }
  if (!parseBoolean(e.MUSE_DAEMON_DELIVERY_ENABLED, true)) {
    safetyEnvironment.MUSE_DAEMON_DELIVERY_ENABLED = "false";
  }
  if (providerLock === "log") {
    safetyEnvironment.MUSE_DAEMON_PROVIDER_LOCK = "log";
  }
  const heavyWorkUnitsPerTick = resolveDaemonHeavyWorkUnitsPerTick(e);
  if (heavyWorkUnitsPerTick > 0) {
    safetyEnvironment.MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK = heavyWorkUnitsPerTick.toString();
  }
  Object.assign(safetyEnvironment, daemonResourcePolicyEnvironment(e));
  Object.assign(safetyEnvironment, backgroundModelExecutionBudgetEnvironment(e));
  Object.assign(safetyEnvironment, autoReindexBudgetEnvironment(e));
  const plist = buildLaunchAgentPlist({
    environmentVariables: safetyEnvironment,
    label: LAUNCH_AGENT_LABEL,
    programArguments: [process.execPath, cliEntry, "daemon"],
    stderrPath: join(logDir, "daemon.err.log"),
    stdoutPath: join(logDir, "daemon.out.log")
  });

  const runLaunchctl = helpers.runLaunchctl ?? defaultRunLaunchctl;

  // Unload any stale definition FIRST. `load -w` is NOT reliably
  // idempotent for an already-loaded label — some launchd versions
  // return non-zero AND don't re-read the plist, so a bare load after
  // an edit (a node upgrade, a moved `muse`, a plain reinstall) would
  // leave launchd running the OLD programArguments until logout. A
  // failed unload here (nothing was loaded yet) is expected and fine.
  await runLaunchctl(["unload", "-w", plistFile]);

  mkdirSync(dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, plist, "utf8");

  const loadResult = await runLaunchctl(["load", "-w", plistFile]);
  // The source of truth for success is the verifying `list` call, not
  // `load`'s own exit code — and `list` exiting 0 only proves the label
  // is REGISTERED, not that it is actually running. Parse its dump for
  // a PID (running now) vs a non-zero LastExitStatus with no PID
  // (registered but crash-looping) so neither is reported as healthy.
  const listResult = await runLaunchctl(["list", LAUNCH_AGENT_LABEL]);
  const registered = listResult.code === 0;
  const { pid, lastExitStatus } = parseLaunchctlListInfo(listResult.stdout);

  if (registered && pid !== undefined) {
    const loadReportedNonZero = loadResult.code !== 0;
    io.stdout(`muse daemon LaunchAgent written to ${plistFile}\n  loaded via launchctl and RUNNING (pid ${pid.toString()}, label: ${LAUNCH_AGENT_LABEL})${loadReportedNonZero ? " — load itself reported a non-zero exit, but the running pid confirms the new plist took effect" : ""}\n  logs: ${logDir}\n  remove with:  muse daemon --uninstall\n`);
    return { ok: true };
  }

  if (registered && lastExitStatus !== undefined && lastExitStatus !== 0) {
    io.stderr(`launchctl registered ${LAUNCH_AGENT_LABEL} but it is NOT running — last exit status ${lastExitStatus.toString()} (it crashed or failed to start; this is a crash-looping install, not a healthy one).\n  plist: ${plistFile}\n  logs: ${logDir}\n  check the log files above, then \`muse daemon --uninstall\` and retry \`muse daemon --install\`.\n`);
    return { ok: false };
  }

  if (registered) {
    io.stderr(`launchctl registered ${LAUNCH_AGENT_LABEL} but reported no PID and no exit status yet — it has not started running. This can be transient right after install; re-check with \`launchctl list ${LAUNCH_AGENT_LABEL}\` in a few seconds or \`muse daemon --status\`.\n  plist: ${plistFile}\n`);
    return { ok: false };
  }

  // launchctl failed AND the agent does not show up as registered —
  // never claim success on a plist that isn't actually loaded.
  io.stderr(`launchctl load failed (exit ${loadResult.code.toString()}): ${loadResult.stderr.trim() || loadResult.stdout.trim() || "label not found in launchctl list"}\n  plist was written to ${plistFile} but the daemon is NOT loaded — run \`launchctl load -w ${plistFile}\` manually or retry \`muse daemon --install\`.\n`);
  return { ok: false };
}

export function registerDaemonCommands(program: Command, io: ProgramIO, helpers: DaemonHelpers = {}): void {
  const env = () => helpers.env?.() ?? process.env;
  const makeMessaging = helpers.buildMessagingRegistry ?? ((e: NodeJS.ProcessEnv) => buildMessagingRegistry(e));

  program
    .command("daemon")
    .description("Run Muse's background daemon (proactive notices) in one process. --once runs a single tick and exits.")
    .option("--once", "Run exactly one tick of each enabled daemon, then exit")
    .option("--print", "Also echo every delivered notice to stdout (watch the daemon work in the foreground)")
    .option("--status", "Print which daemon ticks are enabled for the current config, then exit")
    .option("--init", "Write the resolved provider + destination to the daemon config file, then exit")
    .option("--pause-heavy-work", "Pause model, sync, and consolidation daemon work until resumed (heartbeat and safety work continue)")
    .option("--resume-heavy-work", "Resume model, sync, and consolidation daemon work on the next tick")
    .option("--install", "Write a macOS LaunchAgent plist AND load it via launchctl so the daemon survives logout/reboot, then exit")
    .option("--safe", "With --install, persist local-only + log lock + delivery brake + self-learning off for controlled activation")
    .option("--uninstall", "Unload the macOS LaunchAgent (or remove the Windows scheduled task) and delete its file, then exit")
    .option("--interval <seconds>", "Tick interval in seconds (default 60)", "60")
    .option("--lead-minutes <minutes>", "Imminent-window lead in minutes (default 10)", "10")
    .option("--provider <id>", "Messaging provider id (default MUSE_PROACTIVE_PROVIDER, else 'log')")
    .option("--destination <id>", "Messaging destination — chat/channel id or log tag (default MUSE_PROACTIVE_DESTINATION or '@me')")
    .action(async (options: {
      readonly once?: boolean;
      readonly print?: boolean;
      readonly status?: boolean;
      readonly init?: boolean;
      readonly pauseHeavyWork?: boolean;
      readonly resumeHeavyWork?: boolean;
      readonly install?: boolean;
      readonly safe?: boolean;
      readonly uninstall?: boolean;
      readonly interval: string;
      readonly leadMinutes: string;
      readonly provider?: string;
      readonly destination?: string;
    }) => {
      const e = env();
      if (options.safe && !options.install) {
        io.stderr("muse daemon --safe is only valid with --install; it persists a contained LaunchAgent activation profile.\n");
        process.exitCode = 1;
        return;
      }
      if (options.pauseHeavyWork && options.resumeHeavyWork) {
        io.stderr("muse daemon --pause-heavy-work and --resume-heavy-work cannot be used together.\n");
        process.exitCode = 1;
        return;
      }
      const deliveryBrakeEngaged = !parseBoolean(e.MUSE_DAEMON_DELIVERY_ENABLED, true);
      // `helpers.env` is a test/composition seam, not an escape hatch. A
      // supplied false cannot downgrade the ambient local-only posture.
      const localOnly = isLocalOnlyEnabled(process.env) || isLocalOnlyEnabled(e);
      const interval = parseBoundedFlag(options.interval, "--interval", 5, 86_400, DEFAULT_DAEMON_INTERVAL_MS / 1000);
      const leadMinutes = parseBoundedFlag(options.leadMinutes, "--lead-minutes", 1, 1_440, 10);

      // The master brake is deliberately before daemon config, registries,
      // credentials, models, calendars, store paths, and every sub-tick. The
      // only authorized mutation in this branch is the daemon-loop heartbeat.
      // Administrative/status commands keep their own existing behavior.
      if (deliveryBrakeEngaged && !options.init && !options.install && !options.uninstall && !options.status && !options.pauseHeavyWork && !options.resumeHeavyWork) {
        const heartbeatDir = defaultProactiveHeartbeatDir(e);
        const heartbeatOnlyTick = async (): Promise<void> => {
          await recordProactiveHeartbeat(heartbeatDir, "daemon-loop").catch(() => false);
        };
        io.stdout("muse daemon — delivery brake engaged (heartbeat-only)\n");
        if (options.once) {
          await heartbeatOnlyTick();
          io.stdout("daemon --once complete (heartbeat-only)\n");
          return;
        }

        const signal = new DaemonStopSignal();
        const stop = (): void => {
          if (signal.stopped) return;
          io.stdout("\n(stopping)\n");
          signal.stop();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        try {
          io.stdout(`  running heartbeat every ${interval.toString()} s — ctrl-c to stop\n`);
          await (helpers.runDaemonLoop ?? runDaemonLoop)({
            intervalMs: interval * 1000,
            onError: (cause) => {
              io.stderr(`heartbeat error: ${errorMessage(cause)}\n`);
            },
            signal,
            tick: heartbeatOnlyTick
          });
        } finally {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
        }
        return;
      }

      // Precedence: flag > env > config file > hardcoded default. The
      // config file (muse daemon --init) lets the user persist
      // provider/destination once instead of exporting env vars.
      const configFile = resolveDaemonConfigFile(e);
      const fileConfig = (helpers.readDaemonConfig ?? readDaemonConfig)(configFile);
      const provider = (options.provider ?? e.MUSE_PROACTIVE_PROVIDER ?? fileConfig.provider ?? "log").trim();
      const destination = (options.destination ?? e.MUSE_PROACTIVE_DESTINATION ?? fileConfig.destination ?? "@me").trim();

      if (options.init) {
        // Preserve any `dailyBrief` block `muse setup briefing` already wrote —
        // this write must not silently disable the daily brief.
        writeDaemonConfig(configFile, {
          destination,
          provider,
          ...(fileConfig.dailyBrief ? { dailyBrief: fileConfig.dailyBrief } : {}),
          ...(fileConfig.heavyWorkPaused ? { heavyWorkPaused: true } : {})
        });
        io.stdout(`muse daemon config written to ${configFile}\n  provider=${provider}, destination=${destination}\n`);
        return;
      }

      if (options.pauseHeavyWork || options.resumeHeavyWork) {
        const nextConfig = options.pauseHeavyWork
          ? { ...fileConfig, heavyWorkPaused: true }
          : {
              ...(fileConfig.dailyBrief ? { dailyBrief: fileConfig.dailyBrief } : {}),
              ...(fileConfig.destination ? { destination: fileConfig.destination } : {}),
              ...(fileConfig.provider ? { provider: fileConfig.provider } : {})
            };
        writeDaemonConfig(configFile, nextConfig);
        io.stdout(options.pauseHeavyWork
          ? "muse daemon — heavyweight work paused; all other work remains subject to the delivery and safety gates.\n"
          : "muse daemon — heavyweight work will resume on the next admitted tick.\n");
        return;
      }

      if (options.install) {
        // Keep the host shell and owner config untouched. `--safe` only
        // changes the allowlisted variables persisted into the new service.
        const installEnvironment: NodeJS.ProcessEnv = options.safe
          ? {
              ...e,
              MUSE_DAEMON_DELIVERY_ENABLED: "false",
              MUSE_DAEMON_PROVIDER_LOCK: "log",
              MUSE_LOCAL_ONLY: "true",
              MUSE_SELFLEARN_ENABLED: "false"
            }
          : e;
        const result = await installDaemonAutostart(io, installEnvironment, {
          ...(helpers.daemonCliEntry !== undefined ? { daemonCliEntry: helpers.daemonCliEntry } : {}),
          ...(helpers.daemonTemporaryRoots ? { daemonTemporaryRoots: helpers.daemonTemporaryRoots } : {}),
          ...(helpers.platform ? { platform: helpers.platform } : {}),
          ...(helpers.runLaunchctl ? { runLaunchctl: helpers.runLaunchctl } : {}),
          ...(helpers.schtasksRun ? { schtasksRun: helpers.schtasksRun } : {})
        });
        if (!result.ok) process.exitCode = 1;
        return;
      }

      if (options.uninstall) {
        const plat = helpers.platform ?? process.platform;
        if (plat === "win32") {
          const run = helpers.schtasksRun ?? defaultSchtasksRun;
          const result = await run(buildSchtasksDeleteArgs(SCHTASKS_TASK_NAME));
          // A missing task also exits non-zero on schtasks — treat any
          // outcome here as "nothing left registered", never a crash.
          io.stdout(result.exitCode === 0
            ? `muse daemon scheduled task '${SCHTASKS_TASK_NAME}' removed\n`
            : `muse daemon scheduled task '${SCHTASKS_TASK_NAME}' was not installed (nothing to remove)\n`);
          return;
        }
        if (plat !== "darwin") {
          io.stderr(`muse daemon --uninstall is only wired for macOS (launchd) and Windows (schtasks) — this platform reports '${plat}'.\n`);
          process.exitCode = 1;
          return;
        }
        const plistFile = resolveLaunchAgentFile(e);
        if (!existsSync(plistFile)) {
          io.stdout(`muse daemon LaunchAgent was not installed at ${plistFile} (nothing to remove)\n`);
          return;
        }
        const runLaunchctl = helpers.runLaunchctl ?? defaultRunLaunchctl;
        await runLaunchctl(["unload", "-w", plistFile]);
        // Verify with `list` — `unload`'s own exit code is not trustworthy
        // (a genuine failure there previously got excused in prose without
        // ever being checked). Only delete the plist once the label is
        // confirmed GONE; otherwise the user is left with a running
        // KeepAlive daemon and no plist on disk to `--uninstall` a second
        // time — an orphan with no route back.
        const listResult = await runLaunchctl(["list", LAUNCH_AGENT_LABEL]);
        const stillRegistered = listResult.code === 0;
        if (stillRegistered) {
          const { pid } = parseLaunchctlListInfo(listResult.stdout);
          io.stderr(`launchctl unload did NOT stop ${LAUNCH_AGENT_LABEL} — it is still registered${pid !== undefined ? ` and running (pid ${pid.toString()})` : ""}. Keeping ${plistFile} so you have a route back.\n  Run \`launchctl unload -w ${plistFile}\` manually (or \`launchctl remove ${LAUNCH_AGENT_LABEL}\`), then retry \`muse daemon --uninstall\`.\n`);
          process.exitCode = 1;
          return;
        }
        try {
          rmSync(plistFile);
        } catch (cause) {
          io.stderr(`launchctl unload succeeded but failed to remove ${plistFile}: ${errorMessage(cause)}\n`);
          process.exitCode = 1;
          return;
        }
        io.stdout(`muse daemon LaunchAgent unloaded and removed (${plistFile})\n`);
        return;
      }

      // A daemon config that resolved to `macos-notification` (onboard's
      // native-notification offer, `--provider`, or env) is useless unless
      // the provider's own opt-in flag is also set — so overlay it to
      // 'true' when the user hasn't voiced an opinion. An EXPLICIT 'false'
      // wins (fail-close on a deliberate opt-out): the registry build then
      // skips the provider and the existing unknown-provider error fires.
      const messagingEnv = provider === "macos-notification" && e.MUSE_MESSAGING_MACOS_NOTIFICATION_ENABLED === undefined
        ? { ...e, MUSE_MESSAGING_MACOS_NOTIFICATION_ENABLED: "true" }
        : e;
      const providerLock = resolveDaemonProviderLock(e);
      const baseMessagingRegistry = makeMessaging(messagingEnv);
      if (!baseMessagingRegistry.has(provider)) {
        const known = baseMessagingRegistry.list().map((p) => p.id);
        const suggestion = closestCommandName(provider, known);
        const hint = suggestion ? ` — did you mean --provider ${suggestion}?` : "";
        io.stderr(`Provider '${provider}' is not registered${hint}. Try --provider log (always available).\n`);
        process.exitCode = 1;
        return;
      }
      // --print echoes every delivered notice to stdout too, so a
      // user running `muse daemon` in the foreground watches it work
      // inline.
      const observableMessagingRegistry: MessagingProviderRegistry = options.print
        ? new Proxy(baseMessagingRegistry, {
            get(target, prop, receiver) {
              if (prop === "send") {
                return async (providerId: string, message: { destination: string; text: string }) => {
                  const result = await target.send(providerId, message);
                  io.stdout(`  📨 ${message.destination}: ${message.text}\n`);
                  return result;
                };
              }
              return Reflect.get(target, prop, receiver);
            }
          })
        : baseMessagingRegistry;
      const messagingRegistry = lockDaemonMessagingRegistry(
        observableMessagingRegistry,
        providerLock
      );

      const trustLedgerFile = resolveProactiveTrustFile(e);

      // Shared budget across the 5 UNASKED notice ticks (pattern / ambient /
      // followup / background-exit / checkins) — reminders and the
      // user-scheduled proactive imminent-item tick are EXEMPT (the user
      // asked for those; the budget only caps what Muse initiates itself).
      // `trustLedgerFile` + `lastDeliveryFile` complete the channel-veto loop
      // (see `resolveInterruptionBudgetWiring`'s doc comment).
      const interruptionBudget = resolveInterruptionBudgetWiring(e);

      // Day-rhythm ("하루 리듬") — the one-click opt-in that lets the
      // briefing/digest ticks auto-route to the paired messaging channel.
      // Both paths are resolved ONCE here; the CONFIG CONTENTS are still
      // read live every tick (see `readDayRhythmConfig` inside each tick)
      // so a web-console toggle takes effect without a daemon restart.
      const dayRhythmConfigFile = resolveMuseCliConfigFilePath(e);
      const channelOwnersFile = resolveIntegrationEnvironment(e).messaging.ownersFile;

      const calendarRegistry = (helpers.buildCalendarRegistry ?? buildCalendarRegistry)(e);
      const tasksFile = resolveTasksFile(e);
      const historyFile = resolveProactiveHistoryFile(e);
      const sidecarFile = e.MUSE_PROACTIVE_SIDECAR_FILE?.trim()?.length
        ? e.MUSE_PROACTIVE_SIDECAR_FILE.trim()
        : join(homedir(), ".muse", "proactive-fired.json");
      const dailyCapRaw = e.MUSE_PROACTIVE_DAILY_CAP ? Number(e.MUSE_PROACTIVE_DAILY_CAP) : 0;
      const dailyCap = Number.isFinite(dailyCapRaw) && dailyCapRaw > 0 ? Math.trunc(dailyCapRaw) : 0;
      const followupsFile = resolveFollowupsFile(e);
      const remindersFile = resolveRemindersFile(e);
      // Never build a model/runtime merely because the resident daemon started.
      // These bindings are populated by `ensureHeavyRuntime` only after an
      // admitted tick; owner pause and resource pressure therefore keep the
      // process genuinely light rather than merely skipping its final calls.
      let followupModel: FollowupModel | undefined;

      // Shared sink: every perception tick (ambient, web-watch, home-watch)
      // routes its notice to the same messaging destination as proactive.
      const rawNoticeSink: ProactiveNoticeSink = {
        deliver: async (notice) => {
          await messagingRegistry.send(provider, {
            destination,
            text: `${notice.title}: ${notice.text}`
          });
        }
      };
      // Quiet hours (do-not-disturb): suppress ambient/awareness chatter
      // during the window so the resident daemon doesn't ping at 3am. Only
      // gates this sink (ambient/web-watch/home-watch) plus the proactive/
      // checkins/pattern ticks below — user-scheduled reminders/follow-ups
      // fire on their own path and are unaffected, so an urgent "pay rent
      // today" reminder still comes through. `liveQuietHours` re-reads the
      // persisted setting (web Settings / `muse quiet`) fresh every tick —
      // the SAME precedence + file `apps/api/src/tick-daemons.ts` consumes.
      const quietHours = liveQuietHours(e, io, e.MUSE_PROACTIVE_QUIET_HOURS, e.MUSE_REMINDER_QUIET_HOURS);
      const noticeSink: ProactiveNoticeSink = gateProactiveNoticeSink(rawNoticeSink, {
        quietHours,
        onSuppress: options.print
          ? (notice): void => io.stdout(`  🌙 quiet hours — held: ${notice.title}\n`)
          : undefined
      });

      // Shared knowledge enricher (ambient "Related" line + briefing
      // related-note) — resolved once, reused by both ticks.
      let knowledgeEnrich = helpers.knowledgeEnrich;

      // Ambient perception is rule-based (no model). Active only when
      // MUSE_AMBIENT_RULES is configured; otherwise the tick is skipped.
      const ambientRaw = e.MUSE_AMBIENT_RULES?.trim();
      let ambientRunner: AmbientNoticeRunner | undefined;
      if (ambientRaw) {
        let ambientRules: ReturnType<typeof parseAmbientNoticeRules>;
        try {
          ambientRules = parseAmbientNoticeRules(ambientRaw);
        } catch {
          ambientRules = [];
        }
        if (ambientRules.length > 0) {
          // Real macOS active-window perception when opted in on darwin
          // (or whenever a test injects the osascript runner); otherwise
          // the file source an external OS helper writes.
          const useMacos = e.MUSE_AMBIENT_SOURCE?.trim() === "macos"
            && (helpers.ambientMacosRun !== undefined || process.platform === "darwin");
          const useWindows = e.MUSE_AMBIENT_SOURCE?.trim() === "windows"
            && (helpers.ambientMacosRun !== undefined || process.platform === "win32");
          let ambientSource;
          if (useMacos) {
            ambientSource = new MacOsActiveWindowSource({
              includeClipboard: parseBoolean(e.MUSE_AMBIENT_CLIPBOARD, false),
              ...(helpers.ambientMacosRun ? { run: helpers.ambientMacosRun } : {})
            });
            io.stdout(`  ambient source: macOS active window\n`);
          } else if (useWindows) {
            ambientSource = new WindowsActiveWindowSource({
              includeClipboard: parseBoolean(e.MUSE_AMBIENT_CLIPBOARD, false),
              ...(helpers.ambientMacosRun ? { run: helpers.ambientMacosRun } : {})
            });
            io.stdout(`  ambient source: Windows active window\n`);
          } else {
            const ambientFile = e.MUSE_AMBIENT_FILE?.trim()?.length
              ? e.MUSE_AMBIENT_FILE.trim()
              : join(homedir(), ".muse", "ambient.json");
            ambientSource = new FileAmbientSignalSource(ambientFile);
          }
          ambientRunner = createAmbientNoticeRunner({
            interruptionBudget,
            rules: ambientRules,
            sink: noticeSink,
            source: ambientSource,
            ...(knowledgeEnrich ? { enrich: knowledgeEnrich } : {})
          });
        }
      }

      // Web-watch is read-only page polling. Active only when
      // MUSE_WEB_WATCH_CONFIG is configured; otherwise the tick is skipped.
      const webWatchRaw = e.MUSE_WEB_WATCH_CONFIG?.trim();
      let webWatchRunner: WebWatchRunner | undefined;
      if (webWatchRaw) {
        const chromeConnection = helpers.chromeConnection;
        const watches = webWatchesFromConfig(webWatchRaw, {
          ...(helpers.fetchImpl ? { fetchImpl: helpers.fetchImpl } : {}),
          ...(chromeConnection ? { chromeConnection } : {})
        });
        if (watches.length > 0) {
          webWatchRunner = createWebWatchRunner({ sink: noticeSink, watches });
        }
      }

      // Home-watch: read-only Home Assistant entity-state polling (e.g.
      // "front door unlocked"). Active only with config + HA creds; a
      // firing watch never acts on the home (outbound-safety).
      // Classify the endpoint before reading the watch config or HA token. A
      // blocked remote integration is deliberately inert: no config parser,
      // runner, tick, or credential access is created for it.
      const homeAssistant = resolveHomeAssistantEnvironment(e);
      let homeWatchRunner: WebWatchRunner | undefined;
      if (homeAssistant.status === "configured") {
        const homeWatchRaw = e.MUSE_HOME_WATCH_CONFIG?.trim();
        if (homeWatchRaw) {
          const homeWatches = homeWatchesFromConfig(homeWatchRaw, {
            baseUrl: homeAssistant.baseUrl,
            localOnly: homeAssistant.localOnly,
            token: homeAssistant.token,
            ...(helpers.fetchImpl ? { fetchImpl: helpers.fetchImpl } : {})
          });
          if (homeWatches.length > 0) {
            homeWatchRunner = createWebWatchRunner({ sink: noticeSink, watches: homeWatches });
          }
        }
      }

      // Standing objectives re-evaluate via the model and notify on the
      // same channel when met. Needs a model — skipped without one.
      const objectivesFile = resolveObjectivesFile(e);
      // Draft-first mode (MUSE_OBJECTIVES_PROPOSE): a met objective
      // PROPOSES its message for the user to confirm (`muse propose`)
      // instead of the daemon sending it autonomously.
      const proposedActionsFile = e.MUSE_PROPOSED_ACTIONS_FILE?.trim()?.length
        ? e.MUSE_PROPOSED_ACTIONS_FILE.trim()
        : join(homedir(), ".muse", "proposed-actions.json");
      const objectivesActionLogFile = resolveActionLogFile(e);
      const buildObjectivesActuator = () => !followupModel
        ? undefined
        : parseBoolean(e.MUSE_OBJECTIVES_PROPOSE, false)
          ? createProposingObjectiveActuator({ destination, providerId: provider, proposedActionsFile })
          : createMessagingObjectiveActuator({ destination, providerId: provider, registry: messagingRegistry });
      const buildObjectivesEvaluate = (): ReturnType<typeof createModelObjectiveEvaluator> | undefined => followupModel
        ? createModelObjectiveEvaluator({
            evidenceDeps: {
              ...(calendarRegistry.list().length > 0
                ? { listCalendarEvents: (range: { readonly from: Date; readonly to: Date }) => calendarRegistry.listEvents(range) }
                : {}),
              // `notes` has no synchronous, keyword-searchable local store
              // wired to this call site (notes search is embedding-index-
              // backed in @muse/recall) — resolving to [] fails closed to
              // "unmet" rather than wiring a heavier async path here.
              queryActionLog: () => queryActionLog(objectivesActionLogFile, {}),
              readReminders: () => readReminders(remindersFile),
              readTasks: () => readTasks(tasksFile)
            },
            model: followupModel.model,
            modelProvider: followupModel.modelProvider
          })
        : undefined;
      let objectivesActuator = buildObjectivesActuator();
      let objectivesEvaluate = buildObjectivesEvaluate();

      if (options.status) {
        // Status is an explicit interactive inspection, not a resident tick.
        // Resolve here so it can truthfully distinguish enabled from disabled
        // integrations, while the background loop stays lazy.
        followupModel = await (helpers.resolveFollowupModel ?? defaultFollowupModel)(e);
        objectivesActuator = buildObjectivesActuator();
        objectivesEvaluate = buildObjectivesEvaluate();
        await resolveCliLanguage(e, () => readConfigStore(io));
        // Will it come back after a reboot, and is it actually alive now?
        // Artifact existence and runtime state are deliberately separate: a
        // stale plist may coexist with an orphaned running launchd job.
        const autostart = await getDaemonAutostartStatus(e, {
          ...(helpers.platform ? { platform: helpers.platform } : {}),
          ...(helpers.runLaunchctl ? { runLaunchctl: helpers.runLaunchctl } : {}),
          ...(helpers.schtasksRun ? { schtasksRun: helpers.schtasksRun } : {})
        });
        const statusSafety = resolveDaemonStatusSafetyGates(e, autostart);
        io.stdout(`muse daemon — readiness (provider=${provider}, destination=${destination}; safety=${statusSafety.source}):\n`);
        io.stdout(`  delivery:   ${statusSafety.deliveryBrakeEngaged ? "heartbeat-only (brake engaged)" : "enabled"}\n`);
        const heavyWorkBudget = resolveDaemonStatusHeavyWorkUnitsPerTick(e, autostart);
        io.stdout(`  heavy-work: ${fileConfig.heavyWorkPaused ? "paused by owner (model/sync/consolidation held)" : `eligible (subject to resource admission; ${heavyWorkBudget === 0 ? "unbounded" : `${heavyWorkBudget.toString()} unit(s) per admitted tick`})`}\n`);
        io.stdout(`  route-lock: ${statusSafety.providerLock === "log" ? "log-only" : "disabled"}\n`);
        io.stdout(`  proactive:  ${statusSafety.deliveryBrakeEngaged ? "blocked (delivery brake engaged)" : "enabled"}\n`);
        io.stdout(`  reminders:  ${statusSafety.deliveryBrakeEngaged ? "blocked (delivery brake engaged)" : "enabled"}\n`);
        if (statusSafety.deliveryBrakeEngaged) {
          io.stdout("  resident execution: heartbeat-only; all remaining lines describe configured features, not running ticks\n");
        }
        io.stdout(`  scheduler:  enabled (recurring \`muse scheduler add\` jobs; \`muse scheduler pause\` suspends)\n`);
        io.stdout(`  followup:   ${followupModel ? "enabled" : "disabled (no model resolved)"}\n`);
        io.stdout(`  objectives: ${objectivesEvaluate && objectivesActuator ? "enabled" : "disabled (no model resolved)"}\n`);
        io.stdout(`  daily-brief: ${fileConfig.dailyBrief?.enabled ? `enabled (daily, at ${fileConfig.dailyBrief.time} local)` : "disabled (run `muse setup briefing`)"}\n`);
        io.stdout(`  email-sync: ${localOnly
          ? "disabled (MUSE_LOCAL_ONLY=true; Gmail standard paths are closed)"
          : parseBoolean(e.MUSE_EMAIL_SYNC_ENABLED, false) && isGmailConfigured(io, e)
            ? "enabled (recent emails → recall)"
            : "disabled (set MUSE_EMAIL_SYNC_ENABLED, then `muse setup email` or MUSE_GMAIL_TOKEN)"}\n`);
        io.stdout(`\n${statusSafety.deliveryBrakeEngaged ? "configured features (held by delivery brake):" : t("daemon.status.featuresHeader")}\n`);
        io.stdout(`  ambient:    ${ambientRunner ? "enabled" : `disabled — ${t("daemon.status.ambient.disabled")}`}\n`);
        io.stdout(`  web-watch:  ${webWatchRunner ? "enabled" : `disabled — ${t("daemon.status.webWatch.disabled")}`}\n`);
        io.stdout(`  home-watch: ${homeWatchRunner
          ? "enabled"
          : homeAssistant.status === "blocked"
            ? `disabled (${homeAssistant.reason})`
            : `disabled — ${t("daemon.status.homeWatch.disabled")}`}\n`);
        io.stdout(`  briefing:   ${parseBoolean(e.MUSE_BRIEFING_ENABLED, false) ? "enabled" : `disabled — ${t("daemon.status.briefing.disabled")}`}\n`);
        io.stdout(`  self-learn: ${!statusSafety.selfLearningEnabled
          ? `disabled (safety gate) — ${t("daemon.status.selfLearn.disabled")}`
          : followupModel
            ? "enabled (distill + decay + consolidate)"
            : `disabled (no model resolved) — ${t("daemon.status.selfLearn.disabled")}`}\n`);
        io.stdout(`  recap:      ${parseBoolean(e.MUSE_RECAP_ENABLED, false) ? `enabled (evening, after ${(e.MUSE_RECAP_HOUR ?? "21").toString()}:00)` : `disabled — ${t("daemon.status.recap.disabled")}`}\n`);
        io.stdout(`  digest:     ${parseBoolean(e.MUSE_DIGEST_ENABLED, true) ? `enabled (daily, at ${(e.MUSE_DIGEST_HOUR ?? "18").toString()}:00 local)` : `disabled — ${t("daemon.status.digest.disabled")}`}\n`);
        io.stdout(`  msg-poll:   ${parseBoolean(e.MUSE_MESSAGING_POLL_ENABLED, false) ? "enabled (new inbound → recallable)" : `disabled — ${t("daemon.status.msgPoll.disabled")}`}\n`);
        io.stdout(`  conflicts:  ${parseBoolean(e.MUSE_CONFLICT_WATCH_ENABLED, false) ? `enabled (warns of upcoming double-bookings, next ${(e.MUSE_CONFLICT_WATCH_WITHIN_DAYS ?? "7").toString()}d)` : `disabled — ${t("daemon.status.conflicts.disabled")}`}\n`);
        io.stdout(`  browsing:   ${parseBoolean(e.MUSE_BROWSING_AUTO_SYNC, false) ? `enabled (Chrome history → recall every ${(e.MUSE_BROWSING_SYNC_INTERVAL_MINUTES ?? "60").toString()} min)` : `disabled — ${t("daemon.status.browsing.disabled")}`}\n`);
        // The resolved source paths — the first thing to check when a
        // tick "isn't firing": is it reading the file you think it is?
        io.stdout(`sources:\n`);
        io.stdout(`  config:     ${configFile}\n`);
        io.stdout(`  tasks:      ${tasksFile}\n`);
        io.stdout(`  reminders:  ${remindersFile}\n`);
        io.stdout(`  scheduler:  ${defaultScheduledJobsFile(e)}\n`);
        io.stdout(`  followups:  ${followupsFile}\n`);
        io.stdout(`  objectives: ${objectivesFile}\n`);
        for (const line of formatDaemonAutostartStatus(autostart)) io.stdout(`${line}\n`);
        return;
      }

      const proactiveTick = makeProactiveTick({
        calendarRegistry,
        dailyCap,
        destination,
        historyFile,
        leadMinutes,
        messagingRegistry,
        provider,
        quietHours,
        sidecarFile,
        stdout: io.stdout,
        tasksFile,
        trustLedgerFile
      });

      const backgroundExitNoticeTick = makeBackgroundExitNoticeTick({
        destination,
        interruptionBudget,
        messagingRegistry,
        provider,
        stdout: io.stdout
      });

      const remindersTick = makeRemindersTick({
        destination,
        messagingRegistry,
        provider,
        remindersFile,
        stdout: io.stdout
      });

      // `muse setup briefing` — a fixed-time daily brief (config read LIVE
      // from `configFile` each tick, so a wizard re-run takes effect without
      // a daemon restart). Sidecar mirrors the recap tick's dedupe file.
      const dailyBriefSidecar = e.MUSE_DAILY_BRIEF_SIDECAR_FILE?.trim()?.length
        ? e.MUSE_DAILY_BRIEF_SIDECAR_FILE.trim()
        : join(homedir(), ".muse", "daily-brief-fired.json");
      const dailyBriefTick = makeDailyBriefTick({
        configFile,
        destination,
        env: e,
        messagingRegistry,
        provider,
        sidecarFile: dailyBriefSidecar,
        stdout: io.stdout
      });

      // Recurring scheduled agent prompts ("매일 아침 9시에 오늘 일정 요약해서
      // 보내줘") — created locally via `muse scheduler add`, no API server
      // required. Quiet hours do NOT suppress it (reminders precedent: the
      // user explicitly scheduled it); `muse scheduler pause` does.
      const schedulerTick = makeSchedulerTick({
        destination,
        env: e,
        messagingRegistry,
        pauseFile: defaultSchedulerPauseFile(e),
        provider,
        schedulerFile: defaultScheduledJobsFile(e),
        stdout: io.stdout
      });

      const buildFollowupTick = (): ReturnType<typeof makeFollowupTick> => makeFollowupTick({
        destination,
        followupModel,
        followupsFile,
        interruptionBudget,
        messagingRegistry,
        provider,
        stdout: io.stdout
      });
      let followupTick = buildFollowupTick();

      const checkinsTick = makeCheckinsTick({
        destination,
        env: e,
        interruptionBudget,
        messagingRegistry,
        provider,
        quietHours,
        stdout: io.stdout
      });

      const buildPatternTick = (): ReturnType<typeof makePatternTick> => makePatternTick({
        destination,
        env: e,
        followupModel,
        interruptionBudget,
        messagingRegistry,
        provider,
        quietHours,
        stdout: io.stdout
      });
      let patternTick = buildPatternTick();

      let ambientTick = makeAmbientTick({ ambientRunner, stdout: io.stdout });

      let webWatchTick = makeWebWatchTick({ stdout: io.stdout, webWatchRunner });

      const buildObjectivesTick = (): ReturnType<typeof makeObjectivesTick> => makeObjectivesTick({
        actuator: objectivesActuator,
        evaluate: objectivesEvaluate,
        file: objectivesFile,
        stdout: io.stdout
      });
      let objectivesTick = buildObjectivesTick();

      const homeWatchTick = makeHomeWatchTick({ homeWatchRunner, stdout: io.stdout });

      // One construction seam keeps the provider-lock structural invariant
      // auditable while still rebuilding after lazy knowledge initialization.
      // `knowledgeEnrich` is read when this builder runs, not captured forever
      // as the initial undefined value.
      const buildBriefingTick = (): ReturnType<typeof makeBriefingTick> => makeBriefingTick({
        briefingCalendarLister: helpers.briefingCalendarLister,
        calendarRegistry,
        channelOwnersFile,
        dayRhythmConfigFile,
        destination,
        env: e,
        knowledgeEnrich,
        leadMinutes,
        messagingRegistry,
        objectivesFile,
        provider,
        reconfirmCardAnsweredFile: resolveReconfirmCardAnsweredFile(e),
        reconfirmCardDeliveryFile: resolveReconfirmCardDeliveryFile(e),
        stdout: io.stdout,
        tasksFile
      });
      let briefingTick = buildBriefingTick();

      const reflectionIntervalRaw = e.MUSE_REFLECTION_INTERVAL_MS ? Number(e.MUSE_REFLECTION_INTERVAL_MS) : DEFAULT_REFLECTION_INTERVAL_MS;
      const reflectionIntervalMs = Number.isFinite(reflectionIntervalRaw) && reflectionIntervalRaw > 0 ? reflectionIntervalRaw : DEFAULT_REFLECTION_INTERVAL_MS;
      const lastReflectionMs: TickRunState = { current: undefined };
      let reflectionTick = makeReflectionTick({
        env: e,
        followupModel,
        intervalMs: reflectionIntervalMs,
        lastRunMs: lastReflectionMs,
        stdout: io.stdout
      });

      // Continuous email ingestion — the always-on half of `muse email sync`: the
      // daemon pulls recent inbox emails into recallable notes on its own tick, so
      // your email is kept in the cited-recall corpus WITHOUT a manual command (the
      // map's "always-on connector" gap; mirrors the messaging poll). Opt-in
      // (MUSE_EMAIL_SYNC_ENABLED + MUSE_GMAIL_TOKEN), interval-throttled, fail-soft
      // (a Gmail blip never breaks the daemon). Read-only + written locally as notes.
      const DEFAULT_EMAIL_SYNC_INTERVAL_MS = 15 * 60 * 1000;
      const emailSyncIntervalRaw = e.MUSE_EMAIL_SYNC_INTERVAL_MS ? Number(e.MUSE_EMAIL_SYNC_INTERVAL_MS) : DEFAULT_EMAIL_SYNC_INTERVAL_MS;
      const emailSyncIntervalMs = Number.isFinite(emailSyncIntervalRaw) && emailSyncIntervalRaw > 0 ? emailSyncIntervalRaw : DEFAULT_EMAIL_SYNC_INTERVAL_MS;
      const emailSyncLimitRaw = e.MUSE_EMAIL_SYNC_LIMIT ? Number(e.MUSE_EMAIL_SYNC_LIMIT) : 20;
      const emailSyncLimit = Number.isFinite(emailSyncLimitRaw) && emailSyncLimitRaw > 0 ? Math.min(100, Math.trunc(emailSyncLimitRaw)) : 20;
      const lastEmailSyncMs: TickRunState = { current: undefined };
      let emailSyncTick: ReturnType<typeof makeEmailSyncTick> | undefined;

      // Unattended learning (distill + subtractive decay) — see
      // `makeSelfLearnTick`'s doc comment for the full brake/safety contract.
      const DEFAULT_SELFLEARN_INTERVAL_MS = 5 * 60 * 1000;
      const selfLearnIntervalRaw = e.MUSE_SELFLEARN_INTERVAL_MS ? Number(e.MUSE_SELFLEARN_INTERVAL_MS) : DEFAULT_SELFLEARN_INTERVAL_MS;
      const selfLearnIntervalMs = Number.isFinite(selfLearnIntervalRaw) && selfLearnIntervalRaw > 0 ? selfLearnIntervalRaw : DEFAULT_SELFLEARN_INTERVAL_MS;
      const lastSelfLearnMs: TickRunState = { current: undefined };
      let selfLearnTick = makeSelfLearnTick({
        env: e,
        followupModel,
        intervalMs: selfLearnIntervalMs,
        lastRunMs: lastSelfLearnMs,
        noticeSink,
        stdout: io.stdout,
        ...(helpers.selfLearnDistill ? { selfLearnDistill: helpers.selfLearnDistill } : {}),
        ...(helpers.contradictionClassify ? { contradictionClassify: helpers.contradictionClassify } : {})
      });

      // Disuse-decay (the FORGETTING half) — see `makeSelfLearnDecayTick`'s
      // doc comment.
      const DEFAULT_SELFLEARN_DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;
      const decayIntervalRaw = e.MUSE_SELFLEARN_DECAY_INTERVAL_MS ? Number(e.MUSE_SELFLEARN_DECAY_INTERVAL_MS) : DEFAULT_SELFLEARN_DECAY_INTERVAL_MS;
      const decayIntervalMs = Number.isFinite(decayIntervalRaw) && decayIntervalRaw > 0 ? decayIntervalRaw : DEFAULT_SELFLEARN_DECAY_INTERVAL_MS;
      const lastDecayMs: TickRunState = { current: undefined };
      const selfLearnDecayTick = makeSelfLearnDecayTick({
        env: e,
        intervalMs: decayIntervalMs,
        lastRunMs: lastDecayMs,
        noticeSink,
        stdout: io.stdout
      });

      // Autonomous playbook CONSOLIDATE — see `makePlaybookConsolidateTick`'s
      // doc comment for the sign-safe merge contract.
      const DEFAULT_SELFLEARN_CONSOLIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
      const consolidateIntervalRaw = e.MUSE_SELFLEARN_CONSOLIDATE_INTERVAL_MS ? Number(e.MUSE_SELFLEARN_CONSOLIDATE_INTERVAL_MS) : DEFAULT_SELFLEARN_CONSOLIDATE_INTERVAL_MS;
      const consolidateIntervalMs = Number.isFinite(consolidateIntervalRaw) && consolidateIntervalRaw > 0 ? consolidateIntervalRaw : DEFAULT_SELFLEARN_CONSOLIDATE_INTERVAL_MS;
      const lastConsolidateMs: TickRunState = { current: undefined };
      let playbookConsolidateTick = makePlaybookConsolidateTick({
        env: e,
        followupModel,
        intervalMs: consolidateIntervalMs,
        lastRunMs: lastConsolidateMs,
        stdout: io.stdout,
        ...(helpers.consolidateMerge ? { consolidateMerge: helpers.consolidateMerge } : {}),
        ...(helpers.consolidateValidate ? { consolidateValidate: helpers.consolidateValidate } : {})
      });

      const lastMemoryConsolidateMs: TickRunState = { current: undefined };
      const memoryConsolidateTick = makeMemoryConsolidateTick({
        env: e,
        lastRunMs: lastMemoryConsolidateMs,
        stdout: io.stdout
      });

      // Evening recap — a once-a-day proactive digest of what got done today +
      // what's coming up, delivered after MUSE_RECAP_HOUR (default 21:00) and
      // self-deduped to once per calendar day via a sidecar. Off by default;
      // turns `muse recap` from an on-demand report into anticipation.
      const recapHourRaw = e.MUSE_RECAP_HOUR ? Number(e.MUSE_RECAP_HOUR) : 21;
      const recapHour = Number.isFinite(recapHourRaw) && recapHourRaw >= 0 && recapHourRaw <= 23 ? Math.trunc(recapHourRaw) : 21;
      const recapSidecar = e.MUSE_RECAP_SIDECAR_FILE?.trim()?.length
        ? e.MUSE_RECAP_SIDECAR_FILE.trim()
        : join(homedir(), ".muse", "recap-fired.json");
      const recapTick = makeRecapTick({
        destination,
        env: e,
        messagingRegistry,
        provider,
        recapHour,
        recapSidecar,
        stdout: io.stdout
      });

      // Daily digest flush — the delivery half of the interruption budget
      // (`interruptionBudget` above): whatever the 5 unasked loops suppressed
      // into the digest queue over the day goes out as ONE compiled message.
      // On by default (MUSE_DIGEST_ENABLED); mirrors apps/api's digest-tick
      // so the CLI daemon (which runs several loops the API daemon doesn't
      // duplicate) never leaves its own suppressed notices stranded.
      const digestEnabled = parseBoolean(e.MUSE_DIGEST_ENABLED, true);
      const digestHourRaw = e.MUSE_DIGEST_HOUR ? Number(e.MUSE_DIGEST_HOUR) : undefined;
      const digestQueueFile = resolveDigestQueueFile(e);
      const digestSentFile = resolveDigestSentFile(e);
      const digestFlushTick = makeDigestFlushTick({
        channelOwnersFile,
        dayRhythmConfigFile,
        destination,
        digestEnabled,
        digestHourRaw,
        digestQueueFile,
        digestSentFile,
        messagingRegistry,
        provider,
        quietHours,
        stdout: io.stdout
      });

      // Continuous messaging ingestion — pull new inbound (Telegram / Discord /
      // Slack) into the inbox on a throttle; the inbox-injection cursor then
      // makes it recallable via `muse ask` WITHOUT a manual `muse messaging
      // poll`. Off by default; the providers' own update offsets dedup so a
      // re-poll only fetches what's new.
      const pollMessaging = helpers.messagingPoll ?? createMessagingPollDispatchers(e, messagingRegistry).pollAll;
      const DEFAULT_MSG_POLL_INTERVAL_MS = 5 * 60 * 1000;
      const msgPollIntervalRaw = e.MUSE_MESSAGING_POLL_INTERVAL_MS ? Number(e.MUSE_MESSAGING_POLL_INTERVAL_MS) : DEFAULT_MSG_POLL_INTERVAL_MS;
      const msgPollIntervalMs = Number.isFinite(msgPollIntervalRaw) && msgPollIntervalRaw > 0 ? msgPollIntervalRaw : DEFAULT_MSG_POLL_INTERVAL_MS;
      const lastMsgPollMs: TickRunState = { current: undefined };
      const messagingPollTick = makeMessagingPollTick({
        env: e,
        intervalMs: msgPollIntervalMs,
        lastRunMs: lastMsgPollMs,
        poll: pollMessaging,
        stdout: io.stdout
      });

      // Proactive double-booking watch — scan the upcoming calendar window for
      // overlapping events and warn ONCE per clash (a Friday conflict caught on
      // Wednesday). Detection already exists for the `muse today` pull; this is
      // the missing PUSH. Off by default; throttled; a key-dedup sidecar means a
      // standing clash never re-spams. Fail-soft.
      const conflictWatchLister = helpers.conflictWatchCalendarLister
        ?? (calendarRegistry.list().length > 0
          ? (range: { from: Date; to: Date }) => calendarRegistry.listEvents(range)
          : undefined);
      const conflictWatchSidecar = e.MUSE_CONFLICT_WATCH_SIDECAR_FILE?.trim()?.length
        ? e.MUSE_CONFLICT_WATCH_SIDECAR_FILE.trim()
        : join(homedir(), ".muse", "conflict-watch-fired.json");
      const conflictWithinRaw = e.MUSE_CONFLICT_WATCH_WITHIN_DAYS ? Number(e.MUSE_CONFLICT_WATCH_WITHIN_DAYS) : 7;
      const conflictWithinDays = Number.isFinite(conflictWithinRaw) && conflictWithinRaw > 0 ? Math.trunc(conflictWithinRaw) : 7;
      const DEFAULT_CONFLICT_WATCH_INTERVAL_MS = 30 * 60 * 1000;
      const conflictIntervalRaw = e.MUSE_CONFLICT_WATCH_INTERVAL_MS ? Number(e.MUSE_CONFLICT_WATCH_INTERVAL_MS) : DEFAULT_CONFLICT_WATCH_INTERVAL_MS;
      const conflictIntervalMs = Number.isFinite(conflictIntervalRaw) && conflictIntervalRaw > 0 ? conflictIntervalRaw : DEFAULT_CONFLICT_WATCH_INTERVAL_MS;
      const lastConflictWatchMs: TickRunState = { current: undefined };
      const conflictWatchTick = makeConflictWatchTick({
        destination,
        env: e,
        intervalMs: conflictIntervalMs,
        lastRunMs: lastConflictWatchMs,
        lister: conflictWatchLister,
        messagingRegistry,
        provider,
        sidecarFile: conflictWatchSidecar,
        stdout: io.stdout,
        withinDays: conflictWithinDays
      });

      // Opt-in browsing auto-sync — the always-on half of `muse browsing sync`:
      // the daemon reads NEW Chrome visits into the local archive on its own tick,
      // so the knows-me model keeps learning from what you read WITHOUT you
      // remembering to run the command (the manual-effort gap that starved recall).
      // CONSENT: off by default — the gate is checked FIRST, before any locate/read,
      // so an absent/false/garbage MUSE_BROWSING_AUTO_SYNC performs ZERO Chrome-file
      // access (the env var being set IS the standing consent, mirroring
      // MUSE_MACOS_ACTUATORS). Interval-throttled (default 60 min); in-memory
      // last-sync (the cursor makes a redundant sync cheap + idempotent, like the
      // sibling email/messaging ticks). Read-only + written locally; fail-soft.
      const browsingIntervalRaw = e.MUSE_BROWSING_SYNC_INTERVAL_MINUTES ? Number(e.MUSE_BROWSING_SYNC_INTERVAL_MINUTES) : 60;
      const browsingIntervalMinutes = Number.isFinite(browsingIntervalRaw) && browsingIntervalRaw > 0 ? Math.trunc(browsingIntervalRaw) : 60;
      const browsingSyncIntervalMs = browsingIntervalMinutes * 60 * 1000;
      const lastBrowsingSyncMs: TickRunState = { current: undefined };
      let browsingAutoSyncTick: ReturnType<typeof makeBrowsingAutoSyncTick> | undefined;

      let heavyRuntime: Promise<void> | undefined;
      const ensureHeavyRuntime = (): Promise<void> => {
        heavyRuntime ??= (async () => {
          // Each resolver is deliberately reached only from the admitted path.
          // A failed optional integration remains a skipped tick, never a
          // reason for the resident loop to die or to retry hot on every tick.
          followupModel = await (helpers.resolveFollowupModel ?? defaultFollowupModel)(e).catch(() => undefined);
          knowledgeEnrich = knowledgeEnrich
            ?? await (helpers.resolveKnowledgeEnrich ?? defaultKnowledgeEnrich)(e).catch(() => undefined);

          if (ambientRaw) {
            let rules: ReturnType<typeof parseAmbientNoticeRules>;
            try { rules = parseAmbientNoticeRules(ambientRaw); } catch { rules = []; }
            if (rules.length > 0) {
              const useMacos = e.MUSE_AMBIENT_SOURCE?.trim() === "macos"
                && (helpers.ambientMacosRun !== undefined || process.platform === "darwin");
              const useWindows = e.MUSE_AMBIENT_SOURCE?.trim() === "windows"
                && (helpers.ambientMacosRun !== undefined || process.platform === "win32");
              const source = useMacos
                ? new MacOsActiveWindowSource({ includeClipboard: parseBoolean(e.MUSE_AMBIENT_CLIPBOARD, false), ...(helpers.ambientMacosRun ? { run: helpers.ambientMacosRun } : {}) })
                : useWindows
                  ? new WindowsActiveWindowSource({ includeClipboard: parseBoolean(e.MUSE_AMBIENT_CLIPBOARD, false), ...(helpers.ambientMacosRun ? { run: helpers.ambientMacosRun } : {}) })
                  : new FileAmbientSignalSource(e.MUSE_AMBIENT_FILE?.trim().length ? e.MUSE_AMBIENT_FILE.trim() : join(homedir(), ".muse", "ambient.json"));
              ambientRunner = createAmbientNoticeRunner({
                interruptionBudget,
                rules,
                sink: noticeSink,
                source,
                ...(knowledgeEnrich ? { enrich: knowledgeEnrich } : {})
              });
              ambientTick = makeAmbientTick({ ambientRunner, stdout: io.stdout });
            }
          }

          if (webWatchRaw) {
            const chromeConnection = helpers.chromeConnection
              ?? await (helpers.resolveChromeConnection ?? defaultChromeConnection)(e).catch(() => undefined);
            const watches = webWatchesFromConfig(webWatchRaw, {
              ...(helpers.fetchImpl ? { fetchImpl: helpers.fetchImpl } : {}),
              ...(chromeConnection ? { chromeConnection } : {})
            });
            webWatchRunner = watches.length > 0 ? createWebWatchRunner({ sink: noticeSink, watches }) : undefined;
            webWatchTick = makeWebWatchTick({ stdout: io.stdout, webWatchRunner });
          }

          objectivesActuator = buildObjectivesActuator();
          objectivesEvaluate = buildObjectivesEvaluate();
          followupTick = buildFollowupTick();
          patternTick = buildPatternTick();
          objectivesTick = buildObjectivesTick();
          briefingTick = buildBriefingTick();
          reflectionTick = makeReflectionTick({ env: e, followupModel, intervalMs: reflectionIntervalMs, lastRunMs: lastReflectionMs, stdout: io.stdout });
          emailSyncTick = localOnly ? undefined : (helpers.makeEmailSyncTick ?? makeEmailSyncTick)({ env: e, intervalMs: emailSyncIntervalMs, io, lastRunMs: lastEmailSyncMs, limit: emailSyncLimit, notesDir: resolveNotesDir(e), stdout: io.stdout, ...(helpers.emailSyncProvider ? { emailSyncProvider: helpers.emailSyncProvider } : {}) });
          selfLearnTick = makeSelfLearnTick({ env: e, followupModel, intervalMs: selfLearnIntervalMs, lastRunMs: lastSelfLearnMs, noticeSink, stdout: io.stdout, ...(helpers.selfLearnDistill ? { selfLearnDistill: helpers.selfLearnDistill } : {}), ...(helpers.contradictionClassify ? { contradictionClassify: helpers.contradictionClassify } : {}) });
          playbookConsolidateTick = makePlaybookConsolidateTick({ env: e, followupModel, intervalMs: consolidateIntervalMs, lastRunMs: lastConsolidateMs, stdout: io.stdout, ...(helpers.consolidateMerge ? { consolidateMerge: helpers.consolidateMerge } : {}), ...(helpers.consolidateValidate ? { consolidateValidate: helpers.consolidateValidate } : {}) });
          browsingAutoSyncTick = makeBrowsingAutoSyncTick({ env: e, intervalMs: browsingSyncIntervalMs, lastRunMs: lastBrowsingSyncMs, stdout: io.stdout, ...(helpers.browsingSync ? { browsingSync: helpers.browsingSync } : {}) });
        })();
        return heavyRuntime;
      };

      const RETENTION_PRUNE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
      const lastRetentionPruneCheckMs: TickRunState = { current: undefined };
      const retentionPruneTick = makeRetentionPruneTick({
        env: e,
        intervalMs: RETENTION_PRUNE_CHECK_INTERVAL_MS,
        lastRunMs: lastRetentionPruneCheckMs,
        print: options.print ?? false,
        stdout: io.stdout,
        workspaceDir: io.workspaceDir ?? process.cwd()
      });

      // R2-1: a generic "the daemon completed a tick round" mark, distinct
      // from proactiveTick's own alive/fired pair (which only reflects the
      // proactive sub-tick). Written FIRST, before any sub-tick can throw,
      // so `muse scheduler add` / `muse status` can answer "is the daemon
      // loop actually running" without depending on any one sub-tick's
      // internals. Fail-soft — a heartbeat write failure never breaks a tick.
      const daemonHeartbeatDir = defaultProactiveHeartbeatDir(e);
      const heavyWorkUnitsPerTick = resolveDaemonHeavyWorkUnitsPerTick(e);
      let lastResourceAdmissionKey: string | undefined;
      const resourceReceiptFile = resolveDaemonResourceReceiptFile(e);
      const signal = new DaemonStopSignal();
      const workloadProfileFile = resolveDaemonWorkloadProfileFile(e);
      let workloadProfile = await readDaemonWorkloadProfile(workloadProfileFile)
        ?? emptyDaemonWorkloadProfile();
      const workloadGovernor = new DaemonWorkloadGovernor([
        { id: "followup", run: (claim) => followupTick(claim) },
        { id: "pattern", run: (claim) => patternTick(claim) },
        { id: "ambient", run: (claim) => ambientTick(claim) },
        { id: "web-watch", run: (claim) => webWatchTick(claim) },
        { id: "objectives", run: (claim) => objectivesTick(claim) },
        { id: "home-watch", run: (claim) => homeWatchTick(claim) },
        { id: "briefing", run: (claim) => briefingTick(claim) },
        { id: "reflection", run: (claim) => reflectionTick(claim) },
        { id: "email-sync", run: (claim) => emailSyncTick?.(claim) ?? Promise.resolve(daemonWorkloadNotReady(localOnly ? "disabled" : "unconfigured")) },
        { id: "self-learn", run: (claim) => selfLearnTick(claim) },
        { id: "self-learn-decay", run: (claim) => selfLearnDecayTick(claim) },
        { id: "playbook-consolidate", run: (claim) => playbookConsolidateTick(claim) },
        { id: "memory-consolidate", run: (claim) => memoryConsolidateTick(claim) },
        { id: "recap", run: (claim) => recapTick(claim) },
        { id: "digest-flush", run: (claim) => digestFlushTick(claim) },
        { id: "browsing-sync", run: (claim) => browsingAutoSyncTick?.(claim) ?? Promise.resolve(daemonWorkloadNotReady("unconfigured")) }
      ]);
      const writeResourceReceipt = async (receipt: DaemonResourceReceipt): Promise<boolean> => {
        let written = false;
        try {
          await (helpers.writeResourceAdmissionReceipt ?? writeDaemonResourceAdmissionReceipt)(resourceReceiptFile, receipt);
          written = true;
        } catch {
          io.stderr("resource: receipt-write-failed\n");
        }
        workloadProfile = recordDaemonWorkloadReceipt(workloadProfile, receipt);
        try {
          await writeDaemonWorkloadProfile(workloadProfileFile, workloadProfile);
        } catch {
          io.stderr("resource: profile-write-failed\n");
        }
        return written;
      };
      const runTick = async (): Promise<void> => {
        await recordProactiveHeartbeat(daemonHeartbeatDir, "daemon-loop").catch(() => false);
        await proactiveTick();
        await backgroundExitNoticeTick();
        await remindersTick();
        await dailyBriefTick();
        await schedulerTick();
        const liveDaemonConfig = (helpers.readDaemonConfig ?? readDaemonConfig)(configFile);
        const resourceSnapshot = (helpers.resourceSnapshot ?? readDaemonResourceSnapshot)();
        const resourceAdmission = assessDaemonResourceAdmission(
          e,
          resourceSnapshot,
          { ownerPaused: liveDaemonConfig.heavyWorkPaused === true }
        );
        const decisionReceipt = workloadDecisionReceipt(resourceAdmission, resourceSnapshot, workloadGovernor.queueDepth);
        const resourceAdmissionKey = `${resourceAdmission.status}:${resourceAdmission.reason ?? ""}`;
        const previousResourceAdmissionKey = lastResourceAdmissionKey;
        const resourceAdmissionChanged = resourceAdmissionKey !== previousResourceAdmissionKey;
        if (resourceAdmissionChanged) {
          lastResourceAdmissionKey = resourceAdmissionKey;
          await writeResourceReceipt(decisionReceipt);
        }
        if (signal.stopped) {
          await writeResourceReceipt(cancelledDecisionReceipt(resourceSnapshot, workloadGovernor.queueDepth));
          return;
        }
        if (resourceAdmission.status === "defer") {
          if (resourceAdmissionChanged) {
            io.stdout(`[${new Date().toISOString()}] resource: deferred heavyweight background work (${resourceAdmission.reason})\n`);
          }
        } else if (previousResourceAdmissionKey?.startsWith("defer:") === true) {
          io.stdout(`[${new Date().toISOString()}] resource: heavyweight background work resumed\n`);
        }
        await checkinsTick();
        if (signal.stopped) {
          await writeResourceReceipt(cancelledDecisionReceipt(resourceSnapshot, workloadGovernor.queueDepth));
          return;
        }
        if (resourceAdmission.status === "admit") {
          await ensureHeavyRuntime();
          if (signal.stopped) {
            await writeResourceReceipt(cancelledDecisionReceipt(resourceSnapshot, workloadGovernor.queueDepth));
            return;
          }
          // Historically an uncapped tick attempted seven delivery/watch lanes
          // plus one maintenance lane. Keep that upper bound while putting all
          // sixteen claimable units behind one fair cursor and one measurement
          // boundary. An explicit cap remains a cap on actual claimed work,
          // not on cheap not-ready checks.
          const cycleBudget = heavyWorkUnitsPerTick === 0 ? 8 : Math.min(heavyWorkUnitsPerTick, 8);
          const completedUnits = new Set<DaemonWorkloadUnitId>();
          for (let completed = 0; completed < cycleBudget; completed += 1) {
            const governedCycle: DaemonWorkloadCycleResult = await workloadGovernor.runAdmittedCycle(signal, completedUnits);
            if (governedCycle.status === "no-work") break;
            if (governedCycle.status === "cancelled-before-claim") {
              await writeResourceReceipt(cancelledDecisionReceipt(resourceSnapshot, workloadGovernor.queueDepth));
              return;
            }
            completedUnits.add(governedCycle.boundary.unit);
            await writeResourceReceipt(withWorkloadBoundary(decisionReceipt, governedCycle.boundary));
            if (governedCycle.boundary.stopRequestedDuring) return;
          }
          if (signal.stopped) {
            await writeResourceReceipt(cancelledDecisionReceipt(resourceSnapshot, workloadGovernor.queueDepth));
            return;
          }
        }
        if (signal.stopped) return;
        await messagingPollTick();
        if (signal.stopped) return;
        await conflictWatchTick();
        if (signal.stopped) return;
        await retentionPruneTick();
      };

      io.stdout(`muse daemon — provider=${provider}, destination=${destination}, lead ${leadMinutes.toString()} min\n`);

      if (options.once) {
        await runTick();
        io.stdout("daemon --once complete\n");
        return;
      }

      const stop = (): void => {
        if (signal.stopped) return;
        io.stdout("\n(stopping)\n");
        signal.stop();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      io.stdout(`  running every ${interval.toString()} s — ctrl-c to stop\n`);
      await (helpers.runDaemonLoop ?? runDaemonLoop)({
        intervalMs: interval * 1000,
        onError: (cause) => {
          io.stderr(`tick error: ${errorMessage(cause)}\n`);
        },
        signal,
        tick: runTick
      });
    });
}
