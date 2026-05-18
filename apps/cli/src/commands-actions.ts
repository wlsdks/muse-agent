/**
 * `muse actions` — review the reviewable autonomous-action log
 * (P6 accountability). The objectives daemon (goal 405) appends a
 * rationale-bearing entry for every autonomous action; P6-b1's
 * promise is that this is "queryable by the user" — this is that
 * read surface. Local mode over the shared `~/.muse/action-log.json`
 * the daemon writes, so no API server is required.
 */

import { resolveActionLogFile } from "@muse/autoconfigure";
import { queryActionLog, type ActionLogEntry } from "@muse/mcp";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import type { ProgramIO } from "./program.js";

const RESULT_FILTERS = ["performed", "refused", "failed", "all"] as const;

function actionLogFile(): string {
  return resolveActionLogFile(process.env as Record<string, string | undefined>);
}

function assertResult(raw: string): void {
  const v = raw.trim().toLowerCase();
  if (RESULT_FILTERS.includes(v as (typeof RESULT_FILTERS)[number])) {
    return;
  }
  const hint = closestCommandName(v, RESULT_FILTERS);
  throw new Error(`--result must be one of: ${RESULT_FILTERS.join(", ")} (got '${raw}')${hint ? ` — did you mean '${hint}'?` : ""}`);
}

function formatEntry(e: ActionLogEntry): string {
  const obj = e.objectiveId ? ` (${e.objectiveId})` : "";
  const detail = e.detail ? ` — ${e.detail}` : "";
  return `${e.when}  [${e.result}]  ${e.what}${obj} — ${e.why}${detail}`;
}

export function registerActionsCommands(program: Command, io: ProgramIO): void {
  program
    .command("actions")
    .description("Review what Muse did autonomously on your behalf (the accountability log)")
    .option("--user <id>", "owner bucket (or 'all')", "local")
    .option("--result <result>", `filter: ${RESULT_FILTERS.join(" | ")}`, "all")
    .option("--limit <n>", "max entries, newest first", "20")
    .action(async (options: { readonly user: string; readonly result: string; readonly limit: string }, command: Command) => {
      try {
        assertResult(options.result);
        const limit = Number.parseInt(options.limit, 10);
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new Error(`--limit must be a positive integer (got '${options.limit}')`);
        }
        const user = options.user.trim();
        const all = await queryActionLog(actionLogFile(), user === "all" ? {} : { userId: user });
        const resultFilter = options.result.trim().toLowerCase();
        const filtered = resultFilter === "all" ? all : all.filter((e) => e.result === resultFilter);
        const shown = filtered.slice(0, limit);
        if (shown.length === 0) {
          io.stdout("No recorded actions.\n");
          return;
        }
        for (const e of shown) {
          io.stdout(`${formatEntry(e)}\n`);
        }
      } catch (cause) {
        io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        command.error("actions failed", { exitCode: 1 });
      }
    });
}
