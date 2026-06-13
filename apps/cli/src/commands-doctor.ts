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
import { isRecord } from "@muse/shared";
import { homedir } from "node:os";
import { join } from "node:path";

import { calibrateAbstention } from "@muse/agent-core";
import { evaluateLocalOnlyPosture, LOCAL_FIRST_DEFAULT_MODEL, mergeModelKeysFromFile, parseBoolean, resolveDefaultModel, resolveEpisodesFile, resolveLearningPauseFile, resolveNotesDir, resolveWeaknessesFile } from "@muse/autoconfigure";
import { analyzeRunOutcomes, isLearningPaused, parseHomeAlertChecks, readEpisodes, readWeaknesses, selectDevFixableWeaknesses, webWatchesFromConfig, type DevFixableWeakness, type RunOutcomeEntry, type RunOutcomeSummary, type WeaknessEntry } from "@muse/mcp";
import type { Command } from "commander";

import { resolveLaunchAgentFile } from "./commands-daemon.js";
import { DEFAULT_EMBED_MODEL, isNotesIndexStale } from "./commands-notes-rag.js";
import { defaultEpisodeIndexFile, loadEpisodeIndex } from "./episode-index.js";
import { resolveOllamaUrl } from "./ollama-url.js";
import { isApiUnreachable } from "./program-helpers.js";
import { atRestDoctorCheck, collectPrivacyPosture } from "./commands-privacy.js";
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
}

interface DoctorSummary {
  readonly allHealthy?: boolean;
  readonly status?: string;
  readonly statusLabel?: string;
  readonly summary?: string;
  readonly generatedAt?: string;
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
      // --calibration is a standalone live mode (Ollama-gated like --grounding).
      if (options.calibration) {
        await runCalibrationDoctor(io, parseAlpha(options.alpha), options.json === true);
        return;
      }
      const renderLocal = async (): Promise<"ok" | "warn" | "fail"> => {
        const report = await runLocalDoctor();
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
        const status = snapshot.status ?? "unknown";
        const label = snapshot.statusLabel ?? "";
        const summary = snapshot.summary ?? "";
        const stamp = snapshot.generatedAt ?? "";
        io.stdout(`[${status}] ${summary}${label ? ` — ${label}` : ""}${stamp ? ` (${stamp})` : ""}\n`);
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
      const sigintHandler = (): void => { stopped = true; };
      process.once("SIGINT", sigintHandler);
      try {
        while (!stopped) {
          io.stdout("\x1b[2J\x1b[H");
          await runOnce();
          io.stdout(`\n  (watching every ${(intervalMs / 1000).toString()}s — Ctrl-C to exit)\n`);
          if (stopped) break;
          await new Promise<void>((resolve) => {
            const handle = setTimeout(resolve, intervalMs);
            const earlyWake = (): void => {
              clearTimeout(handle);
              resolve();
            };
            process.once("SIGINT", earlyWake);
          });
        }
      } finally {
        process.off("SIGINT", sigintHandler);
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
 * Path-from-env resolver matching the empty-env-shadow
 * convention: a shell that pre-clears `MUSE_HOME=` / `MUSE_MCP_CONFIG=`
 * must NOT make the doctor stat the empty path and falsely report
 * `~/.muse` / `mcp.json` as missing. Treat empty / whitespace-only
 * env as "unset" and fall back to the documented default.
 */
export function resolveMuseEnvPath(raw: string | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function classifyMcpServersField(parsed: unknown): {
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
} {
  if (!isRecord(parsed)) {
    return { detail: "mcp.json root must be a JSON object", status: "fail" };
  }
  if (parsed.servers === undefined) {
    return { detail: "0 server(s) — no `servers` key in mcp.json", status: "warn" };
  }
  if (!Array.isArray(parsed.servers)) {
    return { detail: `\`servers\` must be an array (got ${parsed.servers === null ? "null" : typeof parsed.servers})`, status: "fail" };
  }
  const count = parsed.servers.length;
  return { detail: `${count.toString()} server(s) registered`, status: count > 0 ? "ok" : "warn" };
}

/**
 * Validate `MUSE_WEB_WATCH_CONFIG` (the "monitor this page, ping me
 * when X" JSON array). The daemon parses it FAIL-OPEN — a malformed
 * entry is silently dropped, so a user with one typo'd watch gets no
 * notice AND no error, the classic "why isn't it firing?" trap. This
 * surfaces the silent drop. Drives the REAL `webWatchesFromConfig`
 * parser (a no-op Chrome connection so `source: "chrome"` entries
 * count as valid rather than being dropped for lack of a live browser
 * here) so the count can't drift from what the daemon actually builds.
 * Returns `undefined` when unset / an empty array — nothing to report.
 */
export function classifyWebWatchConfig(raw: string | undefined): {
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
} | undefined {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { detail: "MUSE_WEB_WATCH_CONFIG is set but not valid JSON — no pages are being watched", status: "warn" };
  }
  if (!Array.isArray(parsed)) {
    return { detail: "MUSE_WEB_WATCH_CONFIG must be a JSON array — no pages are being watched", status: "warn" };
  }
  const total = parsed.length;
  if (total === 0) return undefined;
  const valid = webWatchesFromConfig(trimmed, { chromeConnection: { callTool: async () => undefined } }).length;
  if (valid === total) {
    return { detail: `${valid.toString()} page-watch(es) configured`, status: "ok" };
  }
  const dropped = total - valid;
  return {
    detail: `${dropped.toString()} of ${total.toString()} web-watch ${dropped === 1 ? "entry is" : "entries are"} invalid and skipped — check id/url/title/message/rule`,
    status: "warn"
  };
}

/**
 * Validate `MUSE_BRIEFING_HOME_ALERTS` (the "surface a home sensor in
 * my briefing when it's in an alert state" JSON array). Like the
 * web-watch config it's parsed FAIL-OPEN, so a typo'd entry (missing
 * entityId/label, an empty alertStates) is silently dropped and the
 * alert never appears in the briefing with no error. This surfaces the
 * silent drop. Drives the REAL `@muse/mcp` `parseHomeAlertChecks` so
 * the count can't drift from what the briefing daemon builds. Returns
 * `undefined` when unset / an empty array — nothing to report.
 */
export function classifyHomeAlertsConfig(raw: string | undefined): {
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
} | undefined {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { detail: "MUSE_BRIEFING_HOME_ALERTS is set but not valid JSON — no home alerts in the briefing", status: "warn" };
  }
  if (!Array.isArray(parsed)) {
    return { detail: "MUSE_BRIEFING_HOME_ALERTS must be a JSON array — no home alerts in the briefing", status: "warn" };
  }
  const total = parsed.length;
  if (total === 0) return undefined;
  const valid = parseHomeAlertChecks(trimmed).length;
  if (valid === total) {
    return { detail: `${valid.toString()} home-alert(s) configured`, status: "ok" };
  }
  const dropped = total - valid;
  return {
    detail: `${dropped.toString()} of ${total.toString()} home-alert ${dropped === 1 ? "entry is" : "entries are"} invalid and skipped — check entityId/label/alertStates`,
    status: "warn"
  };
}

export function resolveDoctorWatchIntervalMs(raw: string | undefined): number {
  const defaultMs = 5_000;
  if (!raw) return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
  const seconds = Math.min(3600, Math.max(1, parsed));
  return Math.round(seconds * 1000);
}

export interface LocalCheck {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

/**
 * Report the model the runtime will ACTUALLY use, mirroring `resolveDefaultModel`.
 * Under local-only (the default) the runtime runs the local model and IGNORES any
 * ambient cloud key — so a box that happens to carry a `GEMINI_API_KEY` must NOT
 * be told "model env: inferred from GEMINI_API_KEY" (which makes a privacy-bound
 * user think their data goes to Gemini, contradicting the very guarantee
 * local-only provides). The cloud-credential inference is reported ONLY under an
 * explicit `MUSE_LOCAL_ONLY=false`, exactly as the router resolves it.
 */
export function modelEnvCheck(env: Record<string, string | undefined>): LocalCheck {
  const explicitModel = (env.MUSE_MODEL ?? env.MUSE_DEFAULT_MODEL)?.trim();
  if (explicitModel && explicitModel.length > 0) {
    return { detail: explicitModel, name: "model env", status: "ok" };
  }
  if (parseBoolean(env.MUSE_LOCAL_ONLY, true)) {
    return {
      detail: `${resolveDefaultModel(env) ?? LOCAL_FIRST_DEFAULT_MODEL} (local-only default — ambient cloud keys ignored)`,
      name: "model env",
      status: "ok"
    };
  }
  const anyKey = [
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY", "OLLAMA_BASE_URL"
  ].find((k) => (env[k] ?? "").trim().length > 0);
  return anyKey
    ? { detail: `inferred from ${anyKey} (MUSE_LOCAL_ONLY=false)`, name: "model env", status: "warn" }
    : { detail: "no MUSE_MODEL / provider key — chat/ask/brief will fail", name: "model env", status: "fail" };
}

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
  const reachable = await (async (): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  })();
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
 * Report the local-only / no-cloud-egress posture as a doctor check.
 * Delegates to the canonical `evaluateLocalOnlyPosture` so `muse doctor`
 * and `muse setup status` can never disagree about the guarantee.
 */
export function localOnlyCheck(env: Record<string, string | undefined>): LocalCheck {
  const posture = evaluateLocalOnlyPosture(env);
  return { detail: posture.detail, name: "local-only", status: posture.status };
}

export interface OllamaPerfEnv {
  readonly flashAttention?: string | undefined;
  readonly kvCacheType?: string | undefined;
}

/**
 * Inference-performance posture of the OLLAMA SERVER (not this process):
 * flash attention + a quantized KV cache roughly halve KV memory, which on a
 * 12B with Muse's long grounded prompts means faster long-context turns and
 * more usable num_ctx on the same RAM. Advisory — warn, never fail.
 */
export function ollamaPerfPostureCheck(values: OllamaPerfEnv): LocalCheck {
  const flashOn = values.flashAttention === "1" || values.flashAttention?.toLowerCase() === "true";
  const kv = values.kvCacheType?.toLowerCase();
  const kvQuantized = kv === "q8_0" || kv === "q4_0";
  if (flashOn && kvQuantized) {
    return { detail: `flash attention on, KV cache ${kv ?? ""} — long-context turns run lighter`, name: "ollama-perf", status: "ok" };
  }
  const missing = [
    ...(flashOn ? [] : ["OLLAMA_FLASH_ATTENTION=1"]),
    ...(kvQuantized ? [] : ["OLLAMA_KV_CACHE_TYPE=q8_0"])
  ];
  return {
    detail: `set ${missing.join(" + ")} on the Ollama server (macOS app: \`launchctl setenv NAME VALUE\` then restart Ollama) — ~halves KV memory for faster long-context turns`,
    name: "ollama-perf",
    status: "warn"
  };
}

/**
 * Resolve the Ollama SERVER's perf env: this process's env first (covers
 * `ollama serve` from the same shell), then macOS launchd (covers Ollama.app,
 * which inherits `launchctl setenv`). Fail-soft — unreadable means unset.
 */
export async function readOllamaPerfEnv(env: Record<string, string | undefined>): Promise<OllamaPerfEnv> {
  const fromLaunchctl = async (name: string): Promise<string | undefined> => {
    if (process.platform !== "darwin") return undefined;
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)("launchctl", ["getenv", name]);
      const value = stdout.trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    flashAttention: env.OLLAMA_FLASH_ATTENTION ?? await fromLaunchctl("OLLAMA_FLASH_ATTENTION"),
    kvCacheType: env.OLLAMA_KV_CACHE_TYPE ?? await fromLaunchctl("OLLAMA_KV_CACHE_TYPE")
  };
}

/**
 * Report whether background self-learning (B1) is actually running — the
 * verifiable-autonomy check (Slice 7). Pure of IO so it's directly testable;
 * the caller resolves `enabled` / `paused` / `installed`.
 */
export function selfLearningCheck(state: {
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly installed: boolean;
}): LocalCheck {
  const name = "self-learning";
  if (state.paused) {
    return { detail: "PAUSED — run `muse playbook resume` to let Muse learn again", name, status: "warn" };
  }
  if (!state.enabled) {
    return { detail: "OFF (default) — set MUSE_IDLE_LEARNING_ENABLED=true to let Muse learn from corrections while idle", name, status: "ok" };
  }
  if (!state.installed) {
    return { detail: "ON this session, but the daemon isn't installed — run `muse daemon --install` so it keeps learning across reboots", name, status: "warn" };
  }
  return { detail: "ON, will run while idle (daemon installed)", name, status: "ok" };
}

interface LocalDoctorReport {
  readonly generatedAt: string;
  readonly checks: readonly LocalCheck[];
  readonly worst: "ok" | "warn" | "fail";
}

/**
 * Surface the dev-fixable weakness fuel as an INFORMATIONAL doctor line (status
 * "ok" — a recurring agent bug is self-knowledge, not a doctor health failure,
 * so it never flips `worst` to warn). Returns undefined when there's nothing to
 * surface, so plain `muse doctor` stays quiet until real fuel accrues. Pure.
 */
export function weaknessFuelCheck(devFixable: readonly DevFixableWeakness[]): LocalCheck | undefined {
  const top = devFixable[0];
  if (!top) {
    return undefined;
  }
  const more = devFixable.length > 1 ? ` (+${(devFixable.length - 1).toString()} more)` : "";
  return {
    detail: `${devFixable.length.toString()} recurring agent bug${devFixable.length === 1 ? "" : "s"} — top: ${top.topic} (${top.axis} ${top.count.toString()}×)${more}. See \`muse doctor --weaknesses\`.`,
    name: "weakness ledger",
    status: "ok"
  };
}

async function runLocalDoctor(): Promise<LocalDoctorReport> {
  const checks: LocalCheck[] = [];

  // Merge ~/.muse/models.json keys into the env view so the model
  // checks below see what the runtime sees. Without this, a user
  // who configured providers exclusively via `muse setup model`
  // (no shell export) gets a misleading "no MUSE_MODEL / provider
  // key — chat/ask/brief will fail" — even though chat/ask/brief
  // actually work because the runtime does its own merge at boot.
  const env = mergeModelKeysFromFile({ ...process.env });

  // Model env — mirrors the runtime's resolveDefaultModel so local-only's
  // "ambient cloud keys ignored" guarantee is reported truthfully.
  checks.push(modelEnvCheck(env));
  // The model the runtime will actually use — under local-only (default) this is
  // the local qwen3:8b even with no MUSE_MODEL set, so the ollama-tag-pulled check
  // below now verifies the REAL default is available (it was silently skipped).
  const muse_model = resolveDefaultModel(env);

  checks.push(localOnlyCheck(env));
  checks.push(ollamaPerfPostureCheck(await readOllamaPerfEnv(env)));

  // At-rest encryption — the discretion ("can't tell anyone") half of the
  // identity, alongside the cloud-egress ("can't reach a cloud") posture above.
  checks.push(atRestDoctorCheck(await collectPrivacyPosture(env)));

  // ~/.muse layout
  const muse_home = resolveMuseEnvPath(process.env.MUSE_HOME, join(homedir(), ".muse"));
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

  // mcp.json
  const mcp_path = resolveMuseEnvPath(process.env.MUSE_MCP_CONFIG, join(muse_home, "mcp.json"));
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

  // Probe exactly what the runtime uses (canonical resolver:
  // default 127.0.0.1 — NOT localhost, which can resolve to IPv6
  // ::1 while Ollama binds IPv4 — + models.json merge + trailing
  // slash trim). Otherwise doctor can falsely report "not
  // reachable" while `muse ask` works.
  const ollama_base = resolveOllamaUrl();
  let ollamaModels: readonly OllamaTagsEntry[] | undefined;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const r = await fetch(`${ollama_base}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (r.ok) {
      const j = await r.json() as { models?: unknown[] };
      ollamaModels = Array.isArray(j.models) ? j.models.filter(isOllamaTagsEntry) : [];
      checks.push({ detail: `${ollama_base} — ${ollamaModels.length.toString()} model(s) loaded`, name: "ollama", status: "ok" });
    } else {
      checks.push({ detail: `${ollama_base} responded ${r.status.toString()}`, name: "ollama", status: "warn" });
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
    const notesIndexPath = join(muse_home, "notes-index.json");
    const indexedModel = await readNotesIndexEmbedModel(notesIndexPath);
    const embedModel = indexedModel ?? DEFAULT_EMBED_MODEL;
    const match = findOllamaModelTag(ollamaModels, embedModel);
    const verdict = embedModelCheck(embedModel, indexedModel !== undefined, match?.size);
    checks.push({ name: "ollama embed model", ...verdict });
  }

  // Notes index health — independent of Ollama: is the second brain actually
  // searchable right now? (recall / ask / `today --connect` return nothing if
  // the index was never built or has gone stale since notes changed.)
  {
    const notesIndexPath = join(muse_home, "notes-index.json");
    const exists = existsSync(notesIndexPath);
    let stale = false;
    if (exists) {
      try {
        stale = await isNotesIndexStale(resolveNotesDir(process.env as Record<string, string | undefined>), notesIndexPath);
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
      const episodeCount = (await readEpisodes(resolveEpisodesFile(process.env as Record<string, string | undefined>))).length;
      const index = await loadEpisodeIndex(defaultEpisodeIndexFile());
      const indexedCount = index?.entries.length ?? 0;
      checks.push({ name: "episode index", ...episodeIndexHealth({ episodeCount, indexedCount }) });
    } catch {
      // a missing/unreadable store is the "no episodes yet" case — skip quietly
    }
  }

  // Outbound messengers (Telegram/Discord/Slack/LINE) — opt-in; surface which
  // are wired so the user knows why `muse messaging send` has/has no target.
  checks.push({ name: "messaging", ...messagingConfigCheck(process.env as Record<string, string | undefined>) });

  // SearXNG (optional — `MUSE_SEARXNG_URL` opt-in). When set, probe
  // both reachability (`/healthz`) AND the JSON-format path that
  // `muse.search` actually uses — a SearXNG instance with the
  // default upstream settings.yml ships HTML-only and returns 400
  // on `format=json`, which would silently send every search through
  // the DDG fallback. Better to surface that here than discover it
  // mid-conversation.
  const searxng_url = process.env.MUSE_SEARXNG_URL?.trim();
  if (searxng_url && searxng_url.length > 0) {
    const base = searxng_url.replace(/\/+$/u, "");
    let health_ok: boolean;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const r = await fetch(`${base}/healthz`, { signal: controller.signal });
      clearTimeout(timeout);
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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2_500);
        const r = await fetch(`${base}/search?q=health&format=json`, {
          headers: { "accept": "application/json" },
          signal: controller.signal
        });
        clearTimeout(timeout);
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
    const parsed = JSON.parse(raw) as { users?: Record<string, unknown> };
    const users = parsed.users ? Object.keys(parsed.users).length : 0;
    checks.push({ detail: `${users.toString()} user(s) seeded`, name: "user-memory", status: users > 0 ? "ok" : "warn" });
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
  const webWatchVerdict = classifyWebWatchConfig(process.env.MUSE_WEB_WATCH_CONFIG);
  if (webWatchVerdict) {
    checks.push({ name: "web-watch config", ...webWatchVerdict });
  }

  // home-alerts config — only reported when actually configured.
  const homeAlertsVerdict = classifyHomeAlertsConfig(process.env.MUSE_BRIEFING_HOME_ALERTS);
  if (homeAlertsVerdict) {
    checks.push({ name: "home-alerts config", ...homeAlertsVerdict });
  }

  // self-learning autonomy (B1 Slice 7): is Muse actually set up to learn while idle?
  checks.push(selfLearningCheck({
    enabled: parseBoolean(env.MUSE_IDLE_LEARNING_ENABLED, false),
    installed: existsSync(resolveLaunchAgentFile(process.env)),
    paused: await isLearningPaused(resolveLearningPauseFile(env)).catch(() => false)
  }));

  // Surface the real-usage failure fuel (dev-fixable recurring agent bugs) so a
  // plain `muse doctor` shows what the agent keeps getting wrong — best-effort,
  // never fails the doctor on a ledger read.
  try {
    const fuel = weaknessFuelCheck(selectDevFixableWeaknesses(await readWeaknesses(resolveWeaknessesFile(env))));
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

function formatLocalDoctor(report: LocalDoctorReport): string {
  const lines: string[] = [];
  const banner = report.worst === "ok"
    ? "[ok] local doctor — all checks passed"
    : report.worst === "warn"
      ? "[warn] local doctor — non-fatal warnings"
      : "[fail] local doctor — at least one fatal check";
  lines.push(banner);
  for (const c of report.checks) {
    const marker = c.status === "ok" ? "✓" : c.status === "warn" ? "·" : "✗";
    lines.push(`  ${marker} ${c.name}: ${c.detail}`);
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

/**
 * Shape of the `/api/tags` model entry we rely on for
 * the model-pulled check. Real Ollama responses also carry
 * `digest`, `modified_at`, and a `details` block; we only need
 * `name` (the full tag, e.g. `qwen3.5:9b-q4_K_M`) and `size` (for
 * the friendly "(6.6 GB)" suffix).
 */
export interface OllamaTagsEntry {
  readonly name: string;
  readonly size?: number;
}

function isOllamaTagsEntry(value: unknown): value is OllamaTagsEntry {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { name?: unknown }).name === "string"
    && ((value as { size?: unknown }).size === undefined
      || typeof (value as { size?: unknown }).size === "number");
}

/**
 * Match `configuredTag` against an Ollama `/api/tags`
 * response. Ollama serialises model identities two ways:
 *   - `name: "qwen3.5:9b-q4_K_M"` for an explicit tag
 *   - `name: "qwen3.5:latest"` when the user pulled `qwen3.5`
 *     without a tag suffix (the "latest" tag is implicit).
 * The doctor user may have configured either form; treat
 * `<base>` and `<base>:latest` as the same identity so a config of
 * `ollama/qwen3.5` still matches when Ollama recorded
 * `qwen3.5:latest`. Returns the matched entry (so callers can
 * surface `.size`) or `undefined`.
 */
export function findOllamaModelTag(
  models: readonly OllamaTagsEntry[],
  configuredTag: string
): OllamaTagsEntry | undefined {
  const normalize = (s: string): string => (s.includes(":") ? s : `${s}:latest`);
  const target = normalize(configuredTag.trim());
  return models.find((m) => normalize(m.name) === target);
}

/**
 * Verdict for the "ollama embed model" doctor check. `hasIndex`
 * distinguishes "an index records this model" from "no index yet,
 * checking the default" so the message is actionable in both
 * cases. `pulledSizeBytes` is the matched tag size, or undefined
 * when the model isn't pulled. Pure so it tests directly.
 */
/**
 * Whether the notes RAG index is actually searchable: present + fresh. A
 * pulled embed model isn't enough — recall / ask / `today --connect` all return
 * nothing if the index was never built or has gone stale since notes changed.
 */
/**
 * Which outbound messengers are wired (Telegram/Discord/Slack/LINE), by their
 * provider tokens. Messaging is opt-in, so none configured is ok — this just
 * makes the wired set visible (e.g. why `muse messaging send` has no target).
 */
export function messagingConfigCheck(env: Record<string, string | undefined>): { readonly detail: string; readonly status: "ok" } {
  const set = (v: string | undefined): boolean => typeof v === "string" && v.trim().length > 0;
  const providers = [
    ["telegram", env.MUSE_TELEGRAM_BOT_TOKEN],
    ["discord", env.MUSE_DISCORD_BOT_TOKEN],
    ["slack", env.MUSE_SLACK_BOT_TOKEN],
    ["line", env.MUSE_LINE_CHANNEL_ACCESS_TOKEN]
  ].filter(([, token]) => set(token)).map(([name]) => name);
  return providers.length === 0
    ? { detail: "no messaging provider configured (opt-in — set MUSE_{TELEGRAM,DISCORD,SLACK}_BOT_TOKEN / MUSE_LINE_CHANNEL_ACCESS_TOKEN to enable)", status: "ok" }
    : { detail: `${providers.length.toString()} messenger(s) wired: ${providers.join(", ")}`, status: "ok" };
}

export function notesIndexHealth(state: { readonly exists: boolean; readonly stale: boolean }): { readonly detail: string; readonly status: "ok" | "warn" } {
  if (!state.exists) {
    return { detail: "no notes index yet — run `muse notes reindex` so recall / ask / `today --connect` can find your notes", status: "warn" };
  }
  if (state.stale) {
    return { detail: "notes index is stale (notes changed since last build) — run `muse notes reindex` to refresh", status: "warn" };
  }
  return { detail: "notes index present and fresh — recall / ask are searchable", status: "ok" };
}

/**
 * Whether captured past sessions are searchable (recall episodes / `today
 * --connect`). No episodes yet is fine; episodes present but un- or
 * under-indexed means the second brain can't reach prior conversations.
 */
export function episodeIndexHealth(state: { readonly episodeCount: number; readonly indexedCount: number }): { readonly detail: string; readonly status: "ok" | "warn" } {
  if (state.episodeCount === 0) {
    return { detail: "no past sessions captured yet — episodic memory builds up as you use the REPL", status: "ok" };
  }
  if (state.indexedCount === 0) {
    return { detail: `${state.episodeCount.toString()} past session(s) not indexed — run \`muse episode reindex\` so recall / \`today --connect\` can reach them`, status: "warn" };
  }
  if (state.indexedCount < state.episodeCount) {
    return { detail: `episode index lags (${state.indexedCount.toString()}/${state.episodeCount.toString()} indexed) — run \`muse episode reindex\` to catch up`, status: "warn" };
  }
  return { detail: `${state.indexedCount.toString()} past session(s) indexed — searchable via recall / \`today --connect\``, status: "ok" };
}

export function embedModelCheck(
  embedModel: string,
  hasIndex: boolean,
  pulledSizeBytes: number | undefined
): { readonly detail: string; readonly status: "ok" | "warn" } {
  if (pulledSizeBytes !== undefined) {
    return {
      detail: hasIndex
        ? `${embedModel} pulled (${formatBytes(pulledSizeBytes)}) — RAG over ~/notes works`
        : `${embedModel} pulled (${formatBytes(pulledSizeBytes)}) — notes RAG ready once you run \`muse notes reindex\``,
      status: "ok"
    };
  }
  return {
    detail: hasIndex
      ? `${embedModel} NOT pulled — \`ollama pull ${embedModel}\` (notes RAG will degrade on next search)`
      : `${embedModel} NOT pulled — \`ollama pull ${embedModel}\` (notes RAG / \`muse ask\` unavailable until then)`,
    status: "warn"
  };
}

/**
 * Pure parser pulled out for direct testing. Returns
 * the recorded embed model name (or the documented default,
 * `nomic-embed-text`, when the file exists but doesn't carry one)
 * when notes RAG is in use on this host; `undefined` when no
 * index has ever been written.
 *
 * `rawJson` is the literal file body, or `undefined` to mean
 * "ENOENT". Malformed JSON / missing-field cases fall through to
 * the documented default — a noisy probe is better than a silent
 * gap when the user has clearly opted into RAG.
 */
export function parseNotesIndexEmbedModel(rawJson: string | undefined): string | undefined {
  if (rawJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return DEFAULT_EMBED_MODEL;
  }
  if (!parsed || typeof parsed !== "object") return DEFAULT_EMBED_MODEL;
  const candidate = (parsed as { model?: unknown }).model;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return DEFAULT_EMBED_MODEL;
}

async function readNotesIndexEmbedModel(path: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return parseNotesIndexEmbedModel(raw);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Unreadable index (permissions?) — flag the probe instead of
    // silently dropping.
    return parseNotesIndexEmbedModel("");
  }
}

/** GB / MB / kB formatter for doctor's model-pulled detail line. */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "size unknown";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} kB`;
  return `${bytes.toString()} B`;
}

const WEAKNESS_AXIS_LABEL: Record<string, string> = {
  "grounding-gap": "couldn't answer (may be a missing note)",
  "unbacked-action": "said it acted but didn't",
  "wrong-tool": "picked the wrong tool",
  "time-parse": "misread a date/time",
  other: "other"
};

/**
 * Render the Whetstone weakness ledger as an honest self-report: the topics
 * Muse has noticed it keeps getting wrong, busiest first. Pure (no I/O) so it is
 * unit-testable. Empty ledger → an honest "nothing noticed yet" line.
 */
export function formatWeaknesses(entries: readonly WeaknessEntry[]): string {
  if (entries.length === 0) {
    return "🪨 Whetstone: no weak spots recorded yet — I haven't hit a gap I noticed.\n";
  }
  const sorted = [...entries].sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
  const lines = sorted.map((entry) => {
    const label = WEAKNESS_AXIS_LABEL[entry.axis] ?? entry.axis;
    const times = entry.count === 1 ? "1×" : `${entry.count.toString()}×`;
    const day = entry.lastSeen.slice(0, 10);
    return `  • ${entry.topic}  — ${label} (${times}, last ${day})${entry.hint ? `\n      ↳ ${entry.hint}` : ""}`;
  });
  return `🪨 Whetstone — what I've noticed I'm weak at (${sorted.length.toString()} topic${sorted.length === 1 ? "" : "s"}):\n${lines.join("\n")}\n`;
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
  const file = resolveWeaknessesFile(process.env as Record<string, string | undefined>);
  const entries = await readWeaknesses(file);
  const devFixable = selectDevFixableWeaknesses(entries);
  if (asJson) {
    io.stdout(`${JSON.stringify({ devFixable, weaknesses: entries }, null, 2)}\n`);
    return;
  }
  io.stdout(formatWeaknesses(entries));
  io.stdout(formatDevFixableWeaknesses(devFixable));
}

/**
 * Render the run-log failure-RATE report. Pure (no I/O) so it is unit-testable;
 * the rate is the denominator the cumulative weakness ledger lacks — it tells
 * "improving" from "just more usage".
 */
export function formatRunOutcomes(summary: RunOutcomeSummary): string {
  if (summary.labelled === 0) {
    return "📉 Run outcomes: no graded runs yet — ask a few grounded questions and check back.\n";
  }
  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  const head = `📉 Run outcomes over ${summary.labelled.toString()} graded run${summary.labelled === 1 ? "" : "s"}: `
    + `fail-rate ${pct(summary.failRate)} (${summary.grounded} grounded · ${summary.abstain} abstain · ${summary.ungrounded} ungrounded)`;
  if (summary.topFailingTopics.length === 0) {
    return `${head}\n`;
  }
  const topics = summary.topFailingTopics
    .map((t) => `  • ${t.topic} (${t.count.toString()}×)`)
    .join("\n");
  return `${head}\n  top failing topics:\n${topics}\n`;
}

/** Read the run-log outcome entries from `.muse/runs/*.jsonl` (best-effort; a missing dir / bad line is skipped). */
async function readRunOutcomeEntries(workspaceDir: string): Promise<RunOutcomeEntry[]> {
  const runDir = join(workspaceDir, ".muse", "runs");
  let files: string[];
  try {
    files = (await fs.readdir(runDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const entries: RunOutcomeEntry[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(join(runDir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          const record = parsed as { grounded?: unknown; message?: unknown };
          if (typeof record.message === "string") {
            entries.push({ grounded: typeof record.grounded === "string" ? record.grounded : null, message: record.message });
          }
        }
      } catch {
        // a malformed run-log line is skipped, never fatal
      }
    }
  }
  return entries;
}

async function runRunOutcomesDoctor(io: ProgramIO, asJson: boolean): Promise<void> {
  const entries = await readRunOutcomeEntries(io.workspaceDir ?? process.cwd());
  const summary = analyzeRunOutcomes(entries);
  if (asJson) {
    io.stdout(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  io.stdout(formatRunOutcomes(summary));
}

/** Parse `--alpha` into a miss-rate in (0,1); default 0.1. Non-numeric / out-of-range → 0.1. */
export function parseAlpha(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    return 0.1;
  }
  return parsed;
}

export interface CalibrationReport {
  readonly alpha: number;
  readonly targetCoverage: number;
  readonly threshold: number;
  readonly n: number;
  readonly calibrationCoverage: number;
  readonly refuseTotal: number;
  readonly refuseHeld: number;
}

/**
 * Build the conformal calibration readout. `positiveScores` are the retrieval
 * confidence scores of ANSWERABLE items (the threshold must keep these answered);
 * `negativeScores` are the scores of items that SHOULD be refused (a good
 * threshold holds these below it). Pure — the conformal math is in agent-core.
 */
export function buildCalibrationReport(
  positiveScores: readonly number[],
  negativeScores: readonly number[],
  alpha: number
): CalibrationReport {
  const { threshold, calibrationCoverage, n, targetCoverage } = calibrateAbstention(positiveScores, alpha);
  const refuseHeld = negativeScores.reduce((count, score) => (score < threshold ? count + 1 : count), 0);
  return { alpha, calibrationCoverage, n, refuseHeld, refuseTotal: negativeScores.length, targetCoverage, threshold };
}

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;

/** Render the calibration readout as an honest table across the requested alphas. */
export function formatCalibration(reports: readonly CalibrationReport[]): string {
  if (reports.length === 0 || reports[0]!.n === 0) {
    return "🎯 Calibration: no answerable calibration items — nothing to calibrate.\n";
  }
  const lines = [
    `🎯 Abstention calibration (conformal) — ${reports[0]!.n.toString()} answerable + ${reports[0]!.refuseTotal.toString()} should-refuse items`,
    "  α (miss)  target   threshold  answerable-kept  refuse-held",
    ...reports.map((r) => {
      const thr = Number.isFinite(r.threshold) ? r.threshold.toFixed(3) : (r.threshold > 0 ? "+inf" : "-inf");
      return `  ${r.alpha.toFixed(2)}      ≥${pct(r.targetCoverage)}   ${thr.padStart(7)}   ${pct(r.calibrationCoverage).padStart(10)}      ${`${r.refuseHeld.toString()}/${r.refuseTotal.toString()}`.padStart(7)}`;
    })
  ];
  return `${lines.join("\n")}\n`;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function runCalibrationDoctor(io: ProgramIO, alpha: number, asJson: boolean): Promise<void> {
  const baseUrl = resolveOllamaUrl().replace(/\/$/, "");
  const reachable = await (async (): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  })();
  if (!reachable) {
    io.stdout(`calibration — skipped: local Ollama not reachable at ${baseUrl} (a skip is not a pass; start Ollama to measure).\n`);
    return;
  }
  const { createOllamaEmbedder } = await import("@muse/autoconfigure");
  const { GROUNDING_EVAL_CORPUS } = await import("./grounding-eval-corpus.js");
  const embed = createOllamaEmbedder(DEFAULT_EMBED_MODEL);
  let noteVecs: number[][];
  try {
    noteVecs = await Promise.all(GROUNDING_EVAL_CORPUS.notes.map((note) => embed(note.text) as Promise<number[]>));
  } catch (cause) {
    io.stdout(`calibration — skipped: embed model '${DEFAULT_EMBED_MODEL}' unavailable (${cause instanceof Error ? cause.message : String(cause)}).\n`);
    return;
  }
  const topCosine = async (query: string): Promise<number> => {
    const q = (await embed(query)) as number[];
    return noteVecs.reduce((best, vec) => Math.max(best, cosine(q, vec)), Number.NEGATIVE_INFINITY);
  };
  const positives: number[] = [];
  const negatives: number[] = [];
  for (const testCase of GROUNDING_EVAL_CORPUS.cases) {
    if (testCase.kind === "answerable") {
      positives.push(await topCosine(testCase.query));
    } else if (testCase.kind === "refuse") {
      negatives.push(await topCosine(testCase.query));
    }
  }
  const reports = [...new Set([0.05, alpha, 0.2])].sort((a, b) => a - b).map((a) => buildCalibrationReport(positives, negatives, a));
  if (asJson) {
    io.stdout(`${JSON.stringify({ alpha, reports }, null, 2)}\n`);
    return;
  }
  io.stdout(formatCalibration(reports));
  // The chat grounding gate (chat-grounding.ts) reads MUSE_GROUNDING_MIN_COSINE
  // as an opt-in override of its 0.5 default — print how to apply the value the
  // requested alpha calibrated to, so the calibration actually reaches the gate.
  const chosen = reports.find((report) => report.alpha === alpha);
  if (chosen && Number.isFinite(chosen.threshold)) {
    io.stdout(`\n  Apply (opt-in): export MUSE_GROUNDING_MIN_COSINE=${chosen.threshold.toFixed(3)}   # the α=${alpha.toFixed(2)} threshold; the chat gate stays at 0.5 until set\n`);
  }
}
