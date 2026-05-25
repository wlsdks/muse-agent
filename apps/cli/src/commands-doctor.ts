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
import { homedir } from "node:os";
import { join } from "node:path";

import { mergeModelKeysFromFile, resolveNotesDir } from "@muse/autoconfigure";
import { parseHomeAlertChecks, webWatchesFromConfig } from "@muse/mcp";
import type { Command } from "commander";

import { DEFAULT_EMBED_MODEL, isNotesIndexStale } from "./commands-notes-rag.js";
import { resolveOllamaUrl } from "./ollama-url.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function registerDoctorCommand(program: Command, io: ProgramIO, helpers: DoctorCommandHelpers): void {
  program
    .command("doctor")
    .description("Run a runtime health check (model, MCP, calendar, scheduler, etc.)")
    .option("--full", "Emit the full JSON report instead of the one-line summary")
    .option("--json", "Emit JSON even for the summary form")
    .option("--local", "Probe local-only signals (skip the API daemon)")
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
        readonly watch?: boolean;
        readonly interval?: string;
      },
      command: Command
    ) => {
      const runOnce = async (): Promise<"ok" | "warn" | "fail" | "remote"> => {
        if (options.local) {
          const report = await runLocalDoctor();
          if (options.json || options.full) {
            helpers.writeOutput(io, report);
          } else {
            io.stdout(formatLocalDoctor(report));
          }
          return report.worst;
        }
        const path = options.full ? "/api/admin/doctor" : "/api/admin/doctor/summary";
        const response = await helpers.apiRequest(io, command, path);
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
        // Exit code for CI: 0 for ok+warn (non-fatal), 1 for fail.
        if (options.local && worst === "fail") {
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

interface LocalCheck {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

interface LocalDoctorReport {
  readonly generatedAt: string;
  readonly checks: readonly LocalCheck[];
  readonly worst: "ok" | "warn" | "fail";
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

  // Model env
  const muse_model = env.MUSE_MODEL ?? env.MUSE_DEFAULT_MODEL;
  if (muse_model) {
    checks.push({ detail: muse_model, name: "model env", status: "ok" });
  } else {
    const anyKey = [
      "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
      "OPENROUTER_API_KEY", "OLLAMA_BASE_URL"
    ].find((k) => (env[k] ?? "").trim().length > 0);
    if (anyKey) {
      checks.push({ detail: `inferred from ${anyKey}`, name: "model env", status: "warn" });
    } else {
      checks.push({ detail: "no MUSE_MODEL / provider key — chat/ask/brief will fail", name: "model env", status: "fail" });
    }
  }

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
export function notesIndexHealth(state: { readonly exists: boolean; readonly stale: boolean }): { readonly detail: string; readonly status: "ok" | "warn" } {
  if (!state.exists) {
    return { detail: "no notes index yet — run `muse notes reindex` so recall / ask / `today --connect` can find your notes", status: "warn" };
  }
  if (state.stale) {
    return { detail: "notes index is stale (notes changed since last build) — run `muse notes reindex` to refresh", status: "warn" };
  }
  return { detail: "notes index present and fresh — recall / ask are searchable", status: "ok" };
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
    return "nomic-embed-text";
  }
  if (!parsed || typeof parsed !== "object") return "nomic-embed-text";
  const candidate = (parsed as { model?: unknown }).model;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return "nomic-embed-text";
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
