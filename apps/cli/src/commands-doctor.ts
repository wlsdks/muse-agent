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

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { mergeModelKeysFromFile } from "@muse/autoconfigure";
import type { Command } from "commander";

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
    .option("--watch", "Re-run on a fixed cadence until Ctrl-C (default 5s) (goal 068)")
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
        // Goal 030: surface the overall verdict as an exit code so
        // CI / dotfile bootstrap scripts can `muse doctor --local
        // || warn-user`. 0 for ok+warn (non-fatal); 1 for fail.
        if (options.local && worst === "fail") {
          process.exitCode = 1;
        }
        return;
      }

      // Goal 068 — watch mode. Same ANSI clear / cursor-home as
      // `muse status --watch` (goal 046) so the UX is consistent.
      // `--json` short-circuits the loop — emitting JSON every tick
      // is a stream-consumer's job, not doctor's.
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
 * Goal 068 — parse `--interval <n>` for `muse doctor --watch`.
 * Default 5s, clamped to [1, 3600]. Exported for direct test
 * coverage of the boundary behavior. Mirrors
 * `resolveStatusWatchIntervalMs` so the two watch loops share
 * the same parser contract.
 */
export function resolveDoctorWatchIntervalMs(raw: string | undefined): number {
  const defaultMs = 5_000;
  if (!raw) return defaultMs;
  const parsed = Number.parseFloat(raw);
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
  const muse_home = process.env.MUSE_HOME ?? join(homedir(), ".muse");
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
  const mcp_path = process.env.MUSE_MCP_CONFIG ?? join(muse_home, "mcp.json");
  try {
    const raw = await fs.readFile(mcp_path, "utf8");
    try {
      const parsed = JSON.parse(raw) as { servers?: unknown };
      const servers = Array.isArray(parsed.servers) ? parsed.servers.length : 0;
      checks.push({ detail: `${servers.toString()} server(s) registered`, name: "mcp.json", status: "ok" });
    } catch {
      checks.push({ detail: `${mcp_path} exists but is not valid JSON`, name: "mcp.json", status: "fail" });
    }
  } catch {
    checks.push({ detail: "no mcp.json — only loopback servers available", name: "mcp.json", status: "warn" });
  }

  // Ollama reachability (only if base URL is set or default port responds)
  const ollama_base = env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const r = await fetch(`${ollama_base}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (r.ok) {
      const j = await r.json() as { models?: unknown[] };
      const count = Array.isArray(j.models) ? j.models.length : 0;
      checks.push({ detail: `${ollama_base} — ${count.toString()} model(s) loaded`, name: "ollama", status: "ok" });
    } else {
      checks.push({ detail: `${ollama_base} responded ${r.status.toString()}`, name: "ollama", status: "warn" });
    }
  } catch {
    checks.push({ detail: `${ollama_base} not reachable (skip if you don't use Ollama)`, name: "ollama", status: "warn" });
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
  // Goal 030: explicit summary footer + overall verdict so a script
  // wrapper can grep one line and a human can scan to the bottom for
  // a clear "should I worry?" signal.
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
