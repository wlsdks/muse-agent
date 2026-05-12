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
    .action(async (options: { readonly full?: boolean; readonly json?: boolean; readonly local?: boolean }, command: Command) => {
      if (options.local) {
        const report = await runLocalDoctor();
        if (options.json || options.full) {
          helpers.writeOutput(io, report);
          return;
        }
        io.stdout(formatLocalDoctor(report));
        return;
      }
      const path = options.full ? "/api/admin/doctor" : "/api/admin/doctor/summary";
      const response = await helpers.apiRequest(io, command, path);

      if (options.full || options.json) {
        helpers.writeOutput(io, response);
        return;
      }

      if (!isRecord(response)) {
        helpers.writeOutput(io, response);
        return;
      }
      const snapshot = response as DoctorSummary;
      const status = snapshot.status ?? "unknown";
      const label = snapshot.statusLabel ?? "";
      const summary = snapshot.summary ?? "";
      const stamp = snapshot.generatedAt ?? "";
      io.stdout(`[${status}] ${summary}${label ? ` — ${label}` : ""}${stamp ? ` (${stamp})` : ""}\n`);
    });
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

  // Model env
  const muse_model = process.env.MUSE_MODEL ?? process.env.MUSE_DEFAULT_MODEL;
  if (muse_model) {
    checks.push({ detail: muse_model, name: "model env", status: "ok" });
  } else {
    const anyKey = [
      "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
      "OPENROUTER_API_KEY", "OLLAMA_BASE_URL"
    ].find((k) => (process.env[k] ?? "").trim().length > 0);
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
  const ollama_base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
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
  return `${lines.join("\n")}\n`;
}
