/**
 * `muse doctor` command.
 *
 * Default: wraps `/api/admin/doctor/{summary,report}` so operators
 * can run a one-line health check from the terminal without curl.
 *
 * `--local`: skip the API entirely and probe whatever a personal
 * user can see from the host: model env, ~/.muse layout, mcp.json
 * validity, ollama reachability. The personal-JARVIS path — the
 * daemon may not be running, but the assistant still needs to be
 * able to introspect itself.
 */

import { existsSync, promises as fs } from "node:fs";
import { formatRelativeTime } from "./human-formatters.js";
import { parseAlpha, runCalibrationDoctor } from "./commands-doctor-calibration.js";
export { buildCalibrationReport, formatCalibration, parseAlpha } from "./commands-doctor-calibration.js";
import { backgroundProcessCheck, cloudSyncFolderCheck, episodeIndexHealth, localOnlyCheck, messagingConfigCheck, modelEnvCheck, museSpeedEnvCheck, notesIndexHealth, ollamaPerfPostureCheck, permissionModeDriftCheck, probeOllamaPromptCache, promptCacheHealth, platformPostureCheck, privacyRoutingCheck, readMuseSpeedEnv, readOllamaPerfEnv, readSensitiveFileModes, schedulerPauseCheck, secretSourcesCheck, selfLearningCheck, type SensitiveFileTarget, toolResultCapAdvisoryCheck, visionModelCheck, voiceSetupChecks, volatileMountCheck, weaknessFuelCheck, webEgressCheck, type LocalCheck } from "./commands-doctor-checks.js";
import { readProactiveHeartbeatCheck } from "./commands-doctor-heartbeat.js";
export { heartbeatStatusToCheckStatus, proactiveHeartbeatCheck } from "./commands-doctor-heartbeat.js";
import { findOllamaModelTag, type OllamaTagsEntry } from "./commands-doctor-ollama.js";
import { probeOllamaModels } from "./ollama-probe.js";
import { bluetoothShortcutsCheck, brightnessShortcutCheck, focusShortcutsCheck, readNotesIndexEmbedModel } from "./commands-doctor-checks.js";
import { listShortcutNames } from "@muse/macos";
import { embedModelCheck, formatBytes, recallCalibrationCheck } from "./commands-doctor-checks.js";
export { embedModelCheck } from "./commands-doctor-checks.js";
export { parseNotesIndexEmbedModel } from "./commands-doctor-checks.js";
export { findOllamaModelTag } from "./commands-doctor-ollama.js";
export type { OllamaTagsEntry } from "./commands-doctor-ollama.js";
export { episodeIndexHealth, localOnlyCheck, messagingConfigCheck, modelEnvCheck, museSpeedEnvCheck, notesIndexHealth, ollamaPerfPostureCheck, privacyRoutingCheck, promptCacheHealth, selfLearningCheck, weaknessFuelCheck, webEgressCheck } from "./commands-doctor-checks.js";
export type { LocalCheck } from "./commands-doctor-checks.js";
import { classifyHomeAlertsConfig, classifyMcpServersField, classifyWebWatchConfig, resolveDoctorWatchIntervalMs } from "./commands-doctor-config.js";
export { classifyHomeAlertsConfig, classifyMcpServersField, classifyWebWatchConfig, resolveDoctorWatchIntervalMs, resolveMuseEnvPath } from "./commands-doctor-config.js";
import { runRunOutcomesDoctor } from "./commands-doctor-outcomes.js";
export { formatRunOutcomes } from "./commands-doctor-outcomes.js";
import { runApprovalRateDoctor } from "./commands-doctor-approval-rate.js";
export { formatApprovalRateDoctor } from "./commands-doctor-approval-rate.js";
import { isRecord } from "@muse/shared";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { describeOfficialMcpPosture, LOCAL_FIRST_DEFAULT_MODEL, mergeModelKeysFromFile, parseBoolean, resolveActionLogFile, resolveContactsFile, resolveDefaultModel, resolveEpisodesFile, resolveLearningPauseFile, resolveNotesDir, resolveRecallHitsFile, resolveReflectionsFile, resolveWeaknessesFile, type MuseEnvironment, type OfficialMcpPresetPosture } from "@muse/autoconfigure";
import { isLearningPaused, isMasteredWeakness, readBackgroundProcesses, readEpisodes, readPendingLearnEvents, readSchedulerPauseState, readWeaknesses, resolveLearnQueueFile, selectDevFixableWeaknesses, type DevFixableWeakness, type WeaknessEntry } from "@muse/stores";
import { isLocalOnlyEnabled } from "@muse/model";
import type { Command } from "commander";

import { resolveLaunchAgentFile } from "./commands-daemon.js";
import { defaultCredentialPath } from "./credential-store.js";
import { emailAuthCheck } from "./commands-doctor-email.js";
import { DEFAULT_EMBED_MODEL, isNotesIndexStale } from "./commands-notes-rag.js";
import { loadEpisodeIndex } from "./episode-index.js";
import { resolveOllamaUrl } from "./ollama-url.js";
import { isApiUnreachable } from "./program-helpers.js";
import { atRestDoctorCheck, collectPrivacyPosture } from "./commands-privacy.js";
import { sleep, waitForShutdownSignal } from "./async-promises.js";
import type { ProgramIO } from "./program.js";

export interface DoctorCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
  /** Private local-doctor runtime seam used by isolated tests. */
  readonly localRuntime?: DoctorLocalRuntimeOptions;
}

export interface DoctorLocalPaths {
  readonly museHome: string;
  readonly mcpFile: string;
  readonly backgroundFile: string;
  readonly beliefProvenanceFile: string;
  readonly credentialFile: string;
  readonly episodeIndexFile: string;
  readonly schedulerPauseFile: string;
  readonly proactiveHeartbeatDir: string;
  readonly launchAgentFile: string;
  readonly notesIndexFile: string;
  readonly privacyUserMemoryFile: string;
}

export interface DoctorLocalRuntime {
  readonly env: MuseEnvironment;
  readonly homeDir: string;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly paths: DoctorLocalPaths;
}

export interface DoctorLocalRuntimeOptions {
  readonly env?: MuseEnvironment;
  readonly homeDir?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly paths?: Partial<DoctorLocalPaths>;
}

function doctorPath(env: MuseEnvironment, museHome: string, envKey: string, filename: string): string {
  const explicit = env[envKey]?.trim();
  return explicit && explicit.length > 0 ? explicit : join(museHome, filename);
}

/** Resolve local-doctor inputs once, before any diagnostic reader runs. */
export function resolveDoctorLocalRuntime(options: DoctorLocalRuntimeOptions = {}): DoctorLocalRuntime {
  const env: MuseEnvironment = options.env ?? process.env;
  const homeDir = options.homeDir?.trim() || env.HOME?.trim() || homedir();
  const museHome = env.MUSE_HOME?.trim() || join(homeDir, ".muse");
  // Give legacy helpers an owned HOME and sidecar path without spreading or
  // enumerating the supplied environment. This is important for local-only
  // credential-protecting Proxy inputs.
  const defaults: DoctorLocalPaths = {
    backgroundFile: doctorPath(env, museHome, "MUSE_BACKGROUND_PROCESSES_FILE", "background-processes.json"),
    beliefProvenanceFile: doctorPath(env, museHome, "MUSE_BELIEF_PROVENANCE_FILE", "belief-provenance.json"),
    credentialFile: defaultCredentialPath(homeDir),
    episodeIndexFile: doctorPath(env, museHome, "MUSE_EPISODES_INDEX_FILE", "episodes-index.json"),
    launchAgentFile: "",
    mcpFile: doctorPath(env, museHome, "MUSE_MCP_CONFIG", "mcp.json"),
    museHome,
    notesIndexFile: doctorPath(env, museHome, "MUSE_NOTES_INDEX_FILE", "notes-index.json"),
    privacyUserMemoryFile: doctorPath(env, museHome, "MUSE_USER_MEMORY_FILE", "user-memory.json"),
    proactiveHeartbeatDir: "",
    schedulerPauseFile: doctorPath(env, museHome, "MUSE_SCHEDULER_PAUSE_FILE", "scheduler-paused.json")
  };
  const partialPaths = options.paths ?? {};
  const pathsWithoutDerived = { ...defaults, ...partialPaths };
  const sidecar = env.MUSE_PROACTIVE_SIDECAR_FILE?.trim();
  const proactiveHeartbeatDir = partialPaths.proactiveHeartbeatDir
    ?? (sidecar && sidecar.length > 0 ? dirname(sidecar) : museHome);
  const launchAgentEnvBase: NodeJS.ProcessEnv = Object.create(null);
  const launchAgentEnv = new Proxy(launchAgentEnvBase, {
    get(_target, key) {
      return key === "HOME" ? homeDir : Reflect.get(env, key);
    },
    getOwnPropertyDescriptor(_target, key) {
      if (key === "HOME") {
        return { configurable: true, enumerable: true, value: homeDir, writable: false };
      }
      return Reflect.getOwnPropertyDescriptor(env, key);
    },
    has(_target, key) {
      if (key === "HOME") {
        return true;
      }
      return key in env;
    }
  });
  const launchAgentFile = partialPaths.launchAgentFile
    ?? resolveLaunchAgentFile(launchAgentEnv);
  return {
    env,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    homeDir,
    paths: { ...pathsWithoutDerived, launchAgentFile, proactiveHeartbeatDir }
  };
}

export interface DoctorSummary {
  readonly allHealthy?: boolean;
  readonly status?: string;
  readonly statusLabel?: string;
  readonly summary?: string;
  readonly generatedAt?: string;
}

/**
 * The one-line `muse doctor` summary. The generated-at stamp is humanised
 * ("3h ago" / local datetime past 7d) so an operator instantly sees how
 * STALE the health snapshot is — a raw UTC ISO forces mental math. Pure +
 * exported so the line is testable without the API daemon. `now` injectable
 * for deterministic tests.
 */
export function formatDoctorSummaryLine(snapshot: DoctorSummary, now: Date = new Date()): string {
  const status = snapshot.status ?? "unknown";
  const label = snapshot.statusLabel ?? "";
  const summary = snapshot.summary ?? "";
  const stamp = snapshot.generatedAt ? formatRelativeTime(snapshot.generatedAt, now) : "";
  return `[${status}] ${summary}${label ? ` — ${label}` : ""}${stamp ? ` (${stamp})` : ""}`;
}


export function registerDoctorCommand(program: Command, io: ProgramIO, helpers: DoctorCommandHelpers): void {
  program
    .command("doctor")
    .description("Run a runtime health check (model, MCP, calendar, scheduler, etc.)")
    .option("--full", "Emit the full JSON report instead of the one-line summary")
    .option("--json", "Emit JSON even for the summary form")
    .option("--local", "Probe local-only signals (skip the API daemon)")
    .option("--grounding", "Score the bundled faithfulness + false-refusal corpus on the local model and print the two rates")
    .option("--weaknesses", "Show the Whetstone weakness ledger — what Muse has noticed it can't answer / didn't actually do")
    .option("--run-outcomes", "Show the grounding failure RATE over recent .muse/runs run-logs (the denominator the weakness ledger lacks) + top failing topics")
    .option("--approval-rate", "Show per-gate approval/denial counts from the action log — flags a gate class being reflexively approved (a 'rubber stamp')")
    .option("--calibration", "Calibrate the 'I'm not sure' abstention threshold on the bundled edge corpus (conformal coverage guarantee)")
    .option("--alpha <rate>", "Target miss rate for --calibration (default 0.1 → answer ≥90% of answerable items)")
    .option("--watch", "Re-run on a fixed cadence until Ctrl-C (default 5s)")
    .option(
      "--interval <seconds>",
      "Refresh interval in seconds when --watch is set (default 5, clamped to [1, 3600])"
    )
    .action(async (
      options: {
        readonly full?: boolean;
        readonly json?: boolean;
        readonly local?: boolean;
        readonly grounding?: boolean;
        readonly weaknesses?: boolean;
        readonly runOutcomes?: boolean;
        readonly approvalRate?: boolean;
        readonly calibration?: boolean;
        readonly alpha?: string;
        readonly watch?: boolean;
        readonly interval?: string;
      },
      command: Command
    ) => {
      // --grounding is a standalone live mode: score the bundled edge corpus on
      // the local model and print the two rates. Skips (exit 0) when Ollama is
      // down; exit 1 only on a rate regression below the shipped floor.
      if (options.grounding) {
        const status = await runGroundingDoctor(io);
        if (status === "fail") {
          process.exitCode = 1;
        }
        return;
      }
      // --weaknesses is a read-only view of the Whetstone ledger.
      if (options.weaknesses) {
        await runWeaknessesDoctor(io, options.json === true);
        return;
      }
      // --run-outcomes is a read-only failure-RATE view over the run-logs.
      if (options.runOutcomes) {
        await runRunOutcomesDoctor(io, options.json === true);
        return;
      }
      // --approval-rate is a read-only view over the action log's gated approve/deny outcomes.
      if (options.approvalRate) {
        await runApprovalRateDoctor(io, options.json === true);
        return;
      }
      // --calibration is a standalone live mode (Ollama-gated like --grounding).
      if (options.calibration) {
        await runCalibrationDoctor(io, parseAlpha(options.alpha), options.json === true);
        return;
      }
      const renderLocal = async (): Promise<"ok" | "warn" | "fail"> => {
        const report = await runLocalDoctor(helpers.localRuntime);
        if (options.json || options.full) {
          helpers.writeOutput(io, report);
        } else {
          io.stdout(formatLocalDoctor(report));
        }
        return report.worst;
      };

      const runOnce = async (): Promise<"ok" | "warn" | "fail" | "remote"> => {
        if (options.local) {
          return renderLocal();
        }
        const path = options.full ? "/api/admin/doctor" : "/api/admin/doctor/summary";
        let response: unknown;
        try {
          response = await helpers.apiRequest(io, command, path);
        } catch (error) {
          // Local-first: a CLI-only user has no API daemon running, so the
          // default doctor must not dead-end. Fall back to the local probe
          // (read-only diagnostics) exactly as the read commands do.
          if (isApiUnreachable(error)) {
            io.stderr("muse: API not reachable — running the local health check instead (muse doctor --local).\n");
            return renderLocal();
          }
          throw error;
        }
        if (options.full || options.json) {
          helpers.writeOutput(io, response);
          return "remote";
        }
        if (!isRecord(response)) {
          helpers.writeOutput(io, response);
          return "remote";
        }
        const snapshot = response as DoctorSummary;
        io.stdout(`${formatDoctorSummaryLine(snapshot)}\n`);
        return "remote";
      };

      if (!options.watch) {
        const worst = await runOnce();
        // Exit code for CI: 0 for ok+warn (non-fatal), 1 for fail. Covers both
        // --local and the API-unreachable local fallback (the remote summary
        // path returns "remote", never "fail").
        if (worst === "fail") {
          process.exitCode = 1;
        }
        return;
      }

      // --json short-circuits watch mode — per-tick JSON is a
      // stream-consumer's job, not doctor's.
      if (options.json) {
        await runOnce();
        return;
      }
      const intervalMs = resolveDoctorWatchIntervalMs(options.interval);
      let stopped = false;
      const stopSignal = waitForShutdownSignal(["SIGINT"]);
      void stopSignal.then(() => {
        stopped = true;
      });
      while (!stopped) {
        io.stdout("\x1b[2J\x1b[H");
        await runOnce();
        io.stdout(`\n  (watching every ${(intervalMs / 1000).toString()}s — Ctrl-C to exit)\n`);
        if (stopped) break;
        await Promise.race([
          sleep(intervalMs),
          stopSignal.then(() => {
            stopped = true;
            return;
          })
        ]);
      }
    });
}

/**
 * Parse `--interval <n>` for `muse doctor --watch`.
 * Default 5s, clamped to [1, 3600]. Exported for direct test
 * coverage of the boundary behavior. Mirrors
 * `resolveStatusWatchIntervalMs` so the two watch loops share
 * the same parser contract.
 */



/**
 * `muse doctor --grounding` — score the bundled held-out corpus on the REAL
 * local recall + RGV stack and print faithfulness + false-refusal. Makes the
 * `fabrication=0` claim a number the user reads on their own box; the same
 * scorer is the verify-faithfulness-rate regression gate. Skips (returns "ok")
 * when Ollama / the embed model is unreachable — a skip is not a pass, but
 * doctor must not dead-end on a box with no model up (same policy as the live
 * batteries). Lazy imports keep the runtime assembly out of the default path.
 */
async function runGroundingDoctor(io: ProgramIO): Promise<"ok" | "fail"> {
  const baseUrl = resolveOllamaUrl().replace(/\/$/, "");
  const reachable = (await probeOllamaModels(baseUrl, { timeoutMs: 3_000 })).reachable;
  if (!reachable) {
    io.stdout(`grounding edge — skipped: local Ollama not reachable at ${baseUrl} (a skip is not a pass; start Ollama to measure).\n`);
    return "ok";
  }

  const { createMuseRuntimeAssembly, createOllamaEmbedder } = await import("@muse/autoconfigure");
  const { GROUNDING_EVAL_CORPUS } = await import("./grounding-eval-corpus.js");
  const { GROUNDING_THRESHOLDS, createQwenReverify, renderGroundingEvalReport, runGroundingEval } = await import(
    "./grounding-eval-runner.js"
  );

  const embed = createOllamaEmbedder(DEFAULT_EMBED_MODEL);
  try {
    await embed("probe");
  } catch (cause) {
    io.stdout(
      `grounding edge — skipped: embed model '${DEFAULT_EMBED_MODEL}' unavailable (${cause instanceof Error ? cause.message : String(cause)}). Try: ollama pull ${DEFAULT_EMBED_MODEL}\n`
    );
    return "ok";
  }

  const model = process.env.MUSE_DEFAULT_MODEL ?? process.env.MUSE_MODEL ?? LOCAL_FIRST_DEFAULT_MODEL;
  process.env.MUSE_DEFAULT_MODEL ??= model;
  const modelProvider = createMuseRuntimeAssembly().modelProvider;
  if (!modelProvider) {
    io.stdout("grounding edge — skipped: no local model provider configured (set MUSE_DEFAULT_MODEL).\n");
    return "ok";
  }
  const reverify = createQwenReverify(modelProvider, model);

  const result = await runGroundingEval(GROUNDING_EVAL_CORPUS, { embed, reverify });
  const report = renderGroundingEvalReport(result, GROUNDING_THRESHOLDS);
  io.stdout(`${report.text}\n`);
  return report.status;
}


/**
 * Render the official-public MCP presets (GitHub / Notion) as audit doctor
 * lines: for each, whether its env toggle is ON, whether a credential
 * resolves (a BOOLEAN only — the token is NEVER read or printed here), whether
 * the allowlist permits it, and its official provenance URL. This is the
 * external half of the "tell it everything, it can't tell anyone" trust
 * surface — a privacy-first user can SEE exactly which external servers their
 * agent is eligible to reach and WHY. Pure (delegates to
 * `describeOfficialMcpPosture`) so it tests without a doctor run.
 */
export function officialMcpChecks(env: Record<string, string | undefined>): LocalCheck[] {
  return describeOfficialMcpPosture(env).map((posture: OfficialMcpPresetPosture): LocalCheck => ({
    detail: `${posture.detail} — provenance ${posture.provenanceUrl}`,
    name: `mcp:${posture.name}`,
    status: posture.status
  }));
}



export interface LocalDoctorReport {
  readonly generatedAt: string;
  readonly checks: readonly LocalCheck[];
  readonly worst: "ok" | "warn" | "fail";
}


function createDoctorEnvironmentView(merged: MuseEnvironment, runtime: DoctorLocalRuntime): MuseEnvironment {
  // Inherit direct reads from the already-safe model projection, but give every
  // legacy helper an explicit runtime-owned path. No source spread/ownKeys is
  // involved, so a local-only poison env remains safe.
  const view: MuseEnvironment = Object.create(merged);
  const values: Record<string, string> = {
    HOME: runtime.homeDir,
    MUSE_BACKGROUND_PROCESSES_FILE: runtime.paths.backgroundFile,
    MUSE_BELIEF_PROVENANCE_FILE: runtime.paths.beliefProvenanceFile,
    MUSE_DAEMON_PLIST_FILE: runtime.paths.launchAgentFile,
    MUSE_EPISODES_INDEX_FILE: runtime.paths.episodeIndexFile,
    MUSE_HOME: runtime.paths.museHome,
    MUSE_MCP_CONFIG: runtime.paths.mcpFile,
    MUSE_NOTES_INDEX_FILE: runtime.paths.notesIndexFile,
    MUSE_PROACTIVE_SIDECAR_FILE: join(runtime.paths.proactiveHeartbeatDir, ".doctor-heartbeat-sidecar"),
    MUSE_SCHEDULER_PAUSE_FILE: runtime.paths.schedulerPauseFile,
    MUSE_USER_MEMORY_FILE: runtime.paths.privacyUserMemoryFile
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(view, key, { configurable: true, enumerable: true, value, writable: false });
  }
  return view;
}

export async function runLocalDoctor(runtimeOptions: DoctorLocalRuntimeOptions = {}): Promise<LocalDoctorReport> {
  const runtime = resolveDoctorLocalRuntime(runtimeOptions);
  const checks: LocalCheck[] = [];

  // Merge ~/.muse/models.json keys into the env view so the model
  // checks below see what the runtime sees. Without this, a user
  // who configured providers exclusively via `muse setup model`
  // (no shell export) gets a misleading "no MUSE_MODEL / provider
  // key — chat/ask/brief will fail" — even though chat/ask/brief
  // actually work because the runtime does its own merge at boot.
  const env = createDoctorEnvironmentView(mergeModelKeysFromFile(runtime.env), runtime);

  // Model env — mirrors the runtime's resolveDefaultModel so local-only's
  // "ambient cloud keys ignored" guarantee is reported truthfully.
  checks.push(modelEnvCheck(env));
  checks.push(visionModelCheck(env));
  // The model the runtime will actually use — under local-only (default) this is
  // the local qwen3:8b even with no MUSE_MODEL set, so the ollama-tag-pulled check
  // below now verifies the REAL default is available (it was silently skipped).
  const muse_model = resolveDefaultModel(env);

  checks.push(localOnlyCheck(env));
  checks.push(webEgressCheck(env));
  checks.push(privacyRoutingCheck(env));
  checks.push(ollamaPerfPostureCheck(await readOllamaPerfEnv(env)));
  // MEASURE the prompt cache rather than guessing at the server's env (which we
  // cannot see). Ollama's DEFAULT splits the KV cache across parallel slots, so
  // Muse's stable prefix — identity + persona + memory + tool defs, thousands of
  // byte-identical tokens every turn — never hits it, and every turn AND every
  // tool-loop round re-pays the full prompt-eval. Measured on a 12B model: 3163ms
  // cold -> 66ms warm with the cache alive, vs ~2400ms EVERY time without.
  if (muse_model?.startsWith("ollama/") === true) {
    const probe = await probeOllamaPromptCache({
      baseUrl: resolveOllamaUrl(env),
      fetchImpl: runtime.fetchImpl,
      model: muse_model.slice("ollama/".length)
    });
    if (probe) {
      checks.push({ name: "prompt cache", ...promptCacheHealth(probe) });
    }
  }
  checks.push(museSpeedEnvCheck(readMuseSpeedEnv(env)));

  // At-rest encryption — the discretion ("can't tell anyone") half of the
  // identity, alongside the cloud-egress ("can't reach a cloud") posture above.
  checks.push(atRestDoctorCheck(await collectPrivacyPosture(env, {
    homeDir: runtime.homeDir,
    userMemoryFile: runtime.paths.privacyUserMemoryFile
  })));
  checks.push({ name: "scheduler", ...schedulerPauseCheck(await readSchedulerPauseState(runtime.paths.schedulerPauseFile)) });
  checks.push({ name: "background", ...backgroundProcessCheck(await readBackgroundProcesses(runtime.paths.backgroundFile)) });
  checks.push(await readProactiveHeartbeatCheck(env));

  // ~/.muse layout
  const muse_home = runtime.paths.museHome;
  try {
    const stat = await fs.stat(muse_home);
    if (!stat.isDirectory()) {
      checks.push({ detail: `${muse_home} exists but is not a directory`, name: "~/.muse home", status: "fail" });
    } else {
      checks.push({ detail: muse_home, name: "~/.muse home", status: "ok" });
    }
  } catch {
    checks.push({ detail: `${muse_home} missing — first run hasn't seeded it yet`, name: "~/.muse home", status: "warn" });
  }

  // DS-11 — state-directory integrity: is ~/.muse (or MUSE_HOME) somewhere
  // that can silently corrupt or lose Muse's local file stores? Each of
  // these degrades to "ok"/"skipped" on any read failure rather than
  // throwing — a diagnostic probe must never take `muse doctor` down.
  checks.push(cloudSyncFolderCheck(muse_home));
  const volatileCheck = await volatileMountCheck(muse_home);
  if (volatileCheck) {
    checks.push(volatileCheck);
  }

  // Sensitive-file permission drift — generalizes the live finding
  // (recall-hits.json found at 644) to every store Muse writes 0600 by
  // default. The path list is resolved from this local-doctor runtime once.
  const sensitiveTargets: SensitiveFileTarget[] = [
    { label: "user-memory.json", path: join(muse_home, "user-memory.json") },
    { label: "action-log.json", path: resolveActionLogFile(env) },
    { label: "recall-hits.json", path: resolveRecallHitsFile(env) },
    { label: "contacts.json", path: resolveContactsFile(env) },
    { label: "reflections.json", path: resolveReflectionsFile(env) },
    { label: "weaknesses.json", path: resolveWeaknessesFile(env) },
    { label: "belief-provenance.json", path: runtime.paths.beliefProvenanceFile }
  ];
  sensitiveTargets.push({ label: "credentials.json", path: runtime.paths.credentialFile });
  checks.push(permissionModeDriftCheck(await readSensitiveFileModes(sensitiveTargets)));

  // Tool-result-cap advisory — a `MUSE_MAX_TOOL_OUTPUT_CHARS` set too low
  // silently truncates tool evidence feeding the grounding/citation gate.
  checks.push(toolResultCapAdvisoryCheck(env));

  // mcp.json
  const mcp_path = runtime.paths.mcpFile;
  try {
    const raw = await fs.readFile(mcp_path, "utf8");
    try {
      const parsed = JSON.parse(raw) as unknown;
      checks.push({ name: "mcp.json", ...classifyMcpServersField(parsed) });
    } catch {
      checks.push({ detail: `${mcp_path} exists but is not valid JSON`, name: "mcp.json", status: "fail" });
    }
  } catch {
    checks.push({ detail: "no mcp.json — only loopback servers available", name: "mcp.json", status: "warn" });
  }

  // Official-public MCP presets (GitHub / Notion) — the external trust surface:
  // which curated remote servers are toggled on, whether a credential resolves
  // (boolean only — never the token), whether the allowlist permits them, and
  // each one's official provenance URL. So a privacy-first user can audit
  // exactly which external servers the agent is eligible to reach and why.
  for (const check of officialMcpChecks(env)) {
    checks.push(check);
  }

  // Probe exactly what the runtime uses (canonical resolver:
  // default 127.0.0.1 — NOT localhost, which can resolve to IPv6
  // ::1 while Ollama binds IPv4 — + models.json merge + trailing
  // slash trim). Otherwise doctor can falsely report "not
  // reachable" while `muse ask` works.
  const ollama_base = resolveOllamaUrl(env);
  let ollamaModels: readonly OllamaTagsEntry[] | undefined;
  try {
    const probe = await probeOllamaModels(ollama_base, { fetchImpl: runtime.fetchImpl, timeoutMs: 1_500 });
    if (probe.reachable) {
      const models = probe.models.map((model): OllamaTagsEntry => ({ name: model.name, size: model.size ?? 0 }));
      ollamaModels = models;
      checks.push({ detail: `${ollama_base} — ${ollamaModels.length.toString()} model(s) loaded`, name: "ollama", status: "ok" });
    } else {
      const probeDetail = probe.status === undefined
        ? `${ollama_base} not reachable (skip if you don't use Ollama)`
        : `${ollama_base} responded ${probe.status.toString()}`;
      checks.push({ detail: probeDetail, name: "ollama", status: "warn" });
    }
  } catch {
    checks.push({ detail: `${ollama_base} not reachable (skip if you don't use Ollama)`, name: "ollama", status: "warn" });
  }

  // Cross-check the configured ollama tag is actually pulled —
  // otherwise the user hits a confusing mid-stream 404 instead
  // of a clear "ollama pull <tag>" hint here.
  if (ollamaModels && muse_model && muse_model.startsWith("ollama/")) {
    const tag = muse_model.replace(/^ollama\//, "");
    const match = findOllamaModelTag(ollamaModels, tag);
    if (match) {
      checks.push({ detail: `${tag} pulled (${formatBytes(match.size)})`, name: "ollama model", status: "ok" });
    } else {
      checks.push({
        detail: `${tag} NOT pulled — run \`ollama pull ${tag}\``,
        name: "ollama model",
        status: "warn"
      });
    }
  }

  // Embedding model — RAG over ~/notes is a core JARVIS surface
  // (`muse ask` / `muse recall`). Check the index's recorded model
  // when an index exists; otherwise check the default so a user
  // who hasn't reindexed yet still learns the model is missing
  // (consistent with the `muse setup local` proactive nudge).
  if (ollamaModels) {
    const notesIndexPath = runtime.paths.notesIndexFile;
    const indexedModel = await readNotesIndexEmbedModel(notesIndexPath);
    const embedModel = indexedModel ?? DEFAULT_EMBED_MODEL;
    const match = findOllamaModelTag(ollamaModels, embedModel);
    const verdict = embedModelCheck(embedModel, indexedModel !== undefined, match?.size);
    checks.push({ name: "ollama embed model", ...verdict });
    checks.push({ name: "recall calibration", ...recallCalibrationCheck(embedModel, env) });
  }

  // Notes index health — independent of Ollama: is the second brain actually
  // searchable right now? (recall / ask / `today --connect` return nothing if
  // the index was never built or has gone stale since notes changed.)
  {
    const notesIndexPath = runtime.paths.notesIndexFile;
    const exists = existsSync(notesIndexPath);
    let stale = false;
    if (exists) {
      try {
        stale = await isNotesIndexStale(resolveNotesDir(env), notesIndexPath);
      } catch {
        stale = false;
      }
    }
    checks.push({ name: "notes index", ...notesIndexHealth({ exists, stale }) });
  }

  // Episode index health — the other half of the second brain: are past
  // sessions searchable? (recall episodes / `today --connect`).
  {
    try {
      const episodeCount = (await readEpisodes(resolveEpisodesFile(env))).length;
      const index = await loadEpisodeIndex(runtime.paths.episodeIndexFile);
      const indexedCount = index?.entries.length ?? 0;
      checks.push({ name: "episode index", ...episodeIndexHealth({ episodeCount, indexedCount }) });
    } catch {
      // a missing/unreadable store is the "no episodes yet" case — skip quietly
    }
  }

  // Outbound messengers (Telegram/Discord/Slack/LINE) — opt-in; surface which
  // are wired so the user knows why `muse messaging send` has/has no target.
  checks.push({ name: "messaging", ...messagingConfigCheck(env) });

  // Gmail — opt-in; for the refreshing OAuth path (`muse setup email`), a
  // live probe that the stored refresh token still works, not just that a
  // credential file exists. `configDir` is derived from the SAME
  // `credentialFile` path doctor already resolves, so this reads the exact
  // store `muse setup email` writes to, not a second, divergent path.
  checks.push(await emailAuthCheck(
    { configDir: dirname(runtime.paths.credentialFile), fetch: runtime.fetchImpl, stderr: () => undefined, stdout: () => undefined },
    env,
    runtime.fetchImpl
  ));

  // Focus / Do-Not-Disturb toggling (mac_system_set focus_on/focus_off) rides a
  // named user Shortcut — report whether those shortcuts exist. Only meaningful
  // on macOS with the actuators armed; a `shortcuts list` probe that can't run
  // (no access / non-darwin) is reported as "can't tell" by the pure check.
  if (process.platform === "darwin" && parseBoolean(env.MUSE_MACOS_ACTUATORS, false)) {
    const shortcutNames = await listShortcutNames();
    checks.push({ name: "focus shortcuts", ...focusShortcutsCheck(env, shortcutNames) });
    checks.push({ name: "bluetooth shortcuts", ...bluetoothShortcutsCheck(env, shortcutNames) });
    checks.push({ name: "brightness shortcut", ...brightnessShortcutCheck(env, shortcutNames) });
  }

  // Voice loop (STT/TTS) — opt-in, local-only. Report enabled/disabled + the
  // exact install steps when off; the STT guidance points at the MULTILINGUAL
  // whisper model so Korean speech works, and the Korean-TTS note carries the
  // KSS voice's non-commercial license verbatim.
  for (const check of voiceSetupChecks(env)) {
    checks.push(check);
  }

  // SecretSource posture — local-only env projections intentionally do not
  // enumerate arbitrary source keys. Keep the status honest without turning a
  // privacy report into an environment inventory.
  if (isLocalOnlyEnabled(env)) {
    checks.push({
      detail: "environment secret inventory omitted under MUSE_LOCAL_ONLY=true; local vault readers remain on-demand",
      name: "secret sources",
      status: "ok"
    });
  } else {
    checks.push(secretSourcesCheck(env));
  }

  // Platform posture — which OS-dependent surfaces are active on this box.
  checks.push(platformPostureCheck());

  // SearXNG (optional — `MUSE_SEARXNG_URL` opt-in). When set, probe
  // both reachability (`/healthz`) AND the JSON-format path that
  // `muse.search` actually uses — a SearXNG instance with the
  // default upstream settings.yml ships HTML-only and returns 400
  // on `format=json`, which would silently send every search through
  // the DDG fallback. Better to surface that here than discover it
  // mid-conversation.
  const searxng_url = env.MUSE_SEARXNG_URL?.trim();
  if (searxng_url && searxng_url.length > 0) {
    const base = searxng_url.replace(/\/+$/u, "");
    let health_ok: boolean;
    try {
      const r = await runtime.fetchImpl(`${base}/healthz`, { signal: AbortSignal.timeout(1_500) });
      health_ok = r.ok;
    } catch {
      health_ok = false;
    }
    if (!health_ok) {
      checks.push({
        detail: `${base} not reachable (container down? stop with 'docker stop muse-searxng' or restart per docs/setup-local-llm.md)`,
        name: "searxng",
        status: "fail"
      });
    } else {
      // JSON-format probe — the actual code path muse.search uses.
      try {
        const r = await runtime.fetchImpl(`${base}/search?q=health&format=json`, {
          headers: { "accept": "application/json" },
          signal: AbortSignal.timeout(2_500)
        });
        if (!r.ok) {
          checks.push({
            detail: `${base} up but /search?format=json returned ${r.status.toString()} — enable JSON in settings.yml (see docs/setup-local-llm.md)`,
            name: "searxng",
            status: "fail"
          });
        } else {
          const body = await r.json() as { results?: unknown };
          if (!Array.isArray(body.results)) {
            checks.push({
              detail: `${base} returned non-array results — settings.yml may be misconfigured`,
              name: "searxng",
              status: "warn"
            });
          } else {
            checks.push({
              detail: `${base} — JSON format enabled, ${body.results.length.toString()} probe result(s)`,
              name: "searxng",
              status: "ok"
            });
          }
        }
      } catch (cause) {
        checks.push({
          detail: `${base} JSON probe failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          name: "searxng",
          status: "warn"
        });
      }
    }
  } else {
    checks.push({
      detail: "MUSE_SEARXNG_URL not set — muse.search falls back to DuckDuckGo HTML scraping (works, but fragile)",
      name: "searxng",
      status: "ok"
    });
  }

  // user-memory.json
  const memory_path = join(muse_home, "user-memory.json");
  try {
    const raw = await fs.readFile(memory_path, "utf8");
    // Count what Muse actually LEARNED, not how many user rows exist. The old check
    // counted rows — and reported "✓ 3 user(s) seeded" on a store whose three rows
    // were two smoke fixtures and one user holding a single fact planted by a test.
    // A green tick on an empty user model is the most expensive lie this command can
    // tell, because it is the one that stops anybody looking.
    const parsed = JSON.parse(raw) as {
      users?: Record<string, { facts?: Record<string, unknown>; preferences?: Record<string, unknown> }>;
    };
    const rows = Object.values(parsed.users ?? {});
    const learned = rows.reduce(
      (total, row) => total + Object.keys(row.facts ?? {}).length + Object.keys(row.preferences ?? {}).length,
      0
    );
    checks.push({
      detail:
        learned > 0
          ? `${learned.toString()} thing(s) learned about you across ${rows.length.toString()} profile(s) — \`muse learned\` to review`
          : "nothing learned about you yet — Muse has a user model and it is empty",
      name: "user-memory",
      status: learned > 0 ? "ok" : "warn"
    });
  } catch {
    checks.push({ detail: "no user-memory.json — run `muse remember` or `muse memory set --local`", name: "user-memory", status: "warn" });
  }

  // tasks.json
  const tasks_path = join(muse_home, "tasks.json");
  try {
    const raw = await fs.readFile(tasks_path, "utf8");
    const parsed = JSON.parse(raw) as { tasks?: unknown[] };
    const total = Array.isArray(parsed.tasks) ? parsed.tasks.length : 0;
    checks.push({ detail: `${total.toString()} task(s) total`, name: "tasks store", status: "ok" });
  } catch {
    checks.push({ detail: "no tasks.json yet (will be created on first add)", name: "tasks store", status: "ok" });
  }

  // web-watch config — only reported when actually configured.
  const webWatchVerdict = classifyWebWatchConfig(env.MUSE_WEB_WATCH_CONFIG);
  if (webWatchVerdict) {
    checks.push({ name: "web-watch config", ...webWatchVerdict });
  }

  // home-alerts config — only reported when actually configured.
  const homeAlertsVerdict = classifyHomeAlertsConfig(env.MUSE_BRIEFING_HOME_ALERTS);
  if (homeAlertsVerdict) {
    checks.push({ name: "home-alerts config", ...homeAlertsVerdict });
  }

  // self-learning autonomy: is Muse actually set up to learn while idle?
  // The queue depth is the honest number here: it is exactly how many lessons the
  // user has taught that Muse has captured and NOT yet learned. A doctor that stays
  // silent while that backlog grows is the reason it grew.
  const queued = await countPendingLessons(env);
  checks.push(selfLearningCheck({
    // The gate the daemon ITSELF reads is MUSE_SELFLEARN_ENABLED, and it defaults to
    // TRUE. Doctor was asking about MUSE_IDLE_LEARNING_ENABLED — a different flag, for
    // a different thing — and reporting its `false` default as "OFF (default), ok". So
    // the message read "learning is intentionally off, that's fine" when the truth was
    // "learning is on by the code's own default, and has never once run."
    enabled: parseBoolean(env.MUSE_SELFLEARN_ENABLED, true),
    installed: existsSync(resolveLaunchAgentFile(process.env)),
    paused: await isLearningPaused(resolveLearningPauseFile(env)).catch(() => false),
    queued
  }));

  // Surface the real-usage failure fuel (dev-fixable recurring agent bugs) so a
  // plain `muse doctor` shows what the agent keeps getting wrong — best-effort,
  // never fails the doctor on a ledger read.
  try {
    const fuel = weaknessFuelCheck(selectDevFixableWeaknesses(await readWeaknesses(resolveWeaknessesFile(env)), { nowMs: Date.now() }));
    if (fuel) {
      checks.push(fuel);
    }
  } catch {
    // ledger read is best-effort observability — never block the health check
  }

  const worst = checks.reduce<"ok" | "warn" | "fail">((acc, c) => {
    if (c.status === "fail" || acc === "fail") return "fail";
    if (c.status === "warn" || acc === "warn") return "warn";
    return "ok";
  }, "ok");
  return { checks, generatedAt: new Date().toISOString(), worst };
}

/**
 * Per-check marker for the local doctor screen. A warning must be visually
 * DISTINCT from an OK line so "needs attention" is scannable among 20+
 * checks — a neutral `·` reads the same as OK at a glance, so warn gets the
 * ⚠ sign (matching the warning glyph used elsewhere in the CLI).
 */
export function doctorStatusMarker(status: LocalCheck["status"]): string {
  return status === "ok" ? "✓" : status === "warn" ? "⚠" : "✗";
}

function formatLocalDoctor(report: LocalDoctorReport): string {
  const lines: string[] = [];
  const banner = report.worst === "ok"
    ? "[ok] local doctor — all checks passed"
    : report.worst === "warn"
      ? "[warn] local doctor — non-fatal warnings"
      : "[fail] local doctor — at least one fatal check";
  lines.push(banner);
  for (const c of report.checks) {
    lines.push(`  ${doctorStatusMarker(c.status)} ${c.name}: ${c.detail}`);
  }
  // Summary footer — one greppable verdict line for script wrappers.
  const warnCount = report.checks.filter((c) => c.status === "warn").length;
  const failCount = report.checks.filter((c) => c.status === "fail").length;
  const okCount = report.checks.filter((c) => c.status === "ok").length;
  const overall = report.worst === "ok"
    ? "OK"
    : report.worst === "warn"
      ? `WARN — ${warnCount.toString()} warning(s)`
      : `FAIL — ${failCount.toString()} failure(s), ${warnCount.toString()} warning(s)`;
  lines.push("");
  lines.push(`Overall: ${overall}  (${okCount.toString()} ok / ${warnCount.toString()} warn / ${failCount.toString()} fail across ${report.checks.length.toString()} checks)`);
  return `${lines.join("\n")}\n`;
}





const WEAKNESS_AXIS_LABEL: Record<string, string> = {
  "grounding-gap": "couldn't answer (may be a missing note)",
  "unbacked-action": "said it acted but didn't",
  "wrong-tool": "picked the wrong tool",
  "time-parse": "misread a date/time",
  "source-conflict": "your saved notes disagree",
  misgrounding: "answered from sources that didn't support it",
  other: "other"
};

/**
 * Render the Whetstone weakness ledger as an honest self-report: the topics
 * Muse has noticed it keeps getting wrong, busiest first. Pure (no I/O) so it is
 * unit-testable. Empty ledger → an honest "nothing noticed yet" line.
 */
export function formatWeaknesses(entries: readonly WeaknessEntry[], opts?: { readonly nowMs?: number }): string {
  // A MASTERED topic (BKT pKnown ≥ WEAKNESS_MASTERED_AT) has been resolved enough
  // times that it is no longer a CURRENT weakness — exclude it from the "what I'm
  // weak at" report so the inventory matches what the runtime nudges suppress
  // (consistency with isMasteredWeakness; otherwise doctor keeps nagging a topic
  // the user already fixed). With nowMs, BKT-Forget idle decay re-counts a topic
  // whose mastery has gone stale (long since the last grounded confirmation) as active.
  const active = [...entries].filter((entry) => !isMasteredWeakness(entry, { nowMs: opts?.nowMs }));
  const masteredCount = entries.length - active.length;
  const masteredNote = masteredCount > 0 ? ` · ${masteredCount.toString()} mastered` : "";
  if (active.length === 0) {
    return masteredCount > 0
      ? `🪨 Whetstone: no ACTIVE weak spots — ${masteredCount.toString()} topic${masteredCount === 1 ? "" : "s"} mastered (resolved).\n`
      : "🪨 Whetstone: no weak spots recorded yet — I haven't hit a gap I noticed.\n";
  }
  const sorted = active.sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
  const lines = sorted.map((entry) => {
    const label = WEAKNESS_AXIS_LABEL[entry.axis] ?? entry.axis;
    const times = entry.count === 1 ? "1×" : `${entry.count.toString()}×`;
    const day = entry.lastSeen.slice(0, 10);
    return `  • ${entry.topic}  — ${label} (${times}, last ${day})${entry.hint ? `\n      ↳ ${entry.hint}` : ""}`;
  });
  return `🪨 Whetstone — what I've noticed I'm weak at (${sorted.length.toString()} topic${sorted.length === 1 ? "" : "s"}${masteredNote}):\n${lines.join("\n")}\n`;
}

/**
 * Render the dev-fixable callout — Muse's OWN recurring bugs (unbacked-action /
 * wrong-tool / time-parse), separate from the user-fixable grounding gaps. This
 * is the dev loop's fix list. Empty list → "" (no noise when there's nothing).
 * Pure.
 */
export function formatDevFixableWeaknesses(list: readonly DevFixableWeakness[]): string {
  if (list.length === 0) {
    return "";
  }
  const lines = list.map((w) => `  • ${w.topic}  — ${w.axis} (${w.count.toString()}×)`);
  return `🔧 Recurring agent bugs (dev-fixable — Muse's own, not your notes):\n${lines.join("\n")}\n`;
}

async function runWeaknessesDoctor(io: ProgramIO, asJson: boolean): Promise<void> {
  const file = resolveWeaknessesFile(process.env);
  const entries = await readWeaknesses(file);
  const devFixable = selectDevFixableWeaknesses(entries, { nowMs: Date.now() });
  if (asJson) {
    io.stdout(`${JSON.stringify({ devFixable, weaknesses: entries }, null, 2)}\n`);
    return;
  }
  io.stdout(formatWeaknesses(entries, { nowMs: Date.now() }));
  io.stdout(formatDevFixableWeaknesses(devFixable));
}

/**
 * How many lessons the user has taught that Muse has captured but not yet learned.
 * Fail-soft: an unreadable queue reports 0 — a doctor check must never be the thing
 * that breaks.
 */
async function countPendingLessons(env: Record<string, string | undefined>): Promise<number> {
  try {
    return (await readPendingLearnEvents(resolveLearnQueueFile(env))).length;
  } catch {
    return 0;
  }
}
