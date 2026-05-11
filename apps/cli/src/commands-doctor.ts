/**
 * `muse doctor` command. Wraps `/api/admin/doctor/{summary,report}`
 * so operators can run a one-line health check from the terminal
 * without curl.
 */

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
    .action(async (options: { readonly full?: boolean; readonly json?: boolean }, command: Command) => {
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
