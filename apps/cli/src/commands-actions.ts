/**
 * `muse actions` — review the reviewable autonomous-action log.
 * The objectives daemon appends a rationale-bearing entry for
 * every autonomous action; this is the read surface that makes
 * it queryable by the user. Local mode over the shared
 * `~/.muse/action-log.json` the daemon writes, so no API server
 * is required.
 */

import { resolveActionLogFile } from "@muse/autoconfigure";
import { decryptActionLogAtRest, encryptActionLogAtRest, isActionLogEncrypted, queryActionLog, serializeActionLogEntry, verifyActionLogChainFile, type ActionLogEntry } from "@muse/stores";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import type { ProgramIO } from "./program.js";

const RESULT_FILTERS = ["performed", "refused", "failed", "noted", "all"] as const;

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
  const actions = program
    .command("actions")
    .description("Review what Muse did autonomously on your behalf (the accountability log)")
    .option("--user <id>", "owner bucket (or 'all')", "local")
    .option("--result <result>", `filter: ${RESULT_FILTERS.join(" | ")}`, "all")
    .option("--limit <n>", "max entries, newest first", "20")
    .option("--verify", "Check the audit log's hash-chain for silent deletion / reorder / edit (tamper-evident)")
    .option("--json", "Print the raw payload instead of the formatted list")
    .action(async (options: { readonly user: string; readonly result: string; readonly limit: string; readonly verify?: boolean; readonly json?: boolean }, command: Command) => {
      try {
        if (options.verify) {
          const chain = await verifyActionLogChainFile(actionLogFile());
          if (options.json) {
            io.stdout(`${JSON.stringify(chain, null, 2)}\n`);
          } else if (chain.ok) {
            io.stdout(`✓ ${chain.reason}\n`);
          } else {
            io.stderr(
              `✗ TAMPERING DETECTED at entry ${(chain.brokenAtIndex ?? -1).toString()}: ${chain.reason}\n` +
              `  The audit trail of what Muse did on your behalf was altered after the fact.\n`
            );
          }
          if (!chain.ok) {
            command.error("action log integrity check failed", { exitCode: 1 });
          }
          return;
        }
        assertResult(options.result);
        const trimmedLimit = options.limit.trim();
        const limit = /^\d+$/u.test(trimmedLimit) ? Number(trimmedLimit) : Number.NaN;
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new Error(`--limit must be a positive integer (got '${options.limit}')`);
        }
        const user = options.user.trim() || "local";
        const all = await queryActionLog(actionLogFile(), user === "all" ? {} : { userId: user });
        const resultFilter = options.result.trim().toLowerCase();
        const filtered = resultFilter === "all" ? all : all.filter((e) => e.result === resultFilter);
        const shown = filtered.slice(0, limit);
        if (options.json) {
          const payload = {
            entries: shown.map(serializeActionLogEntry),
            result: resultFilter,
            total: shown.length,
            user
          };
          io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
          return;
        }
        if (shown.length === 0) {
          // Channel-triggered actions (e.g. a refused remote tool) land
          // under a `provider:source` bucket, not the default `local`,
          // so a plain `muse actions` would look empty while entries
          // exist elsewhere. Point the user at `--user all` rather than
          // imply nothing happened.
          let suffix = "";
          if (user !== "all" && all.length === 0) {
            const others = await queryActionLog(actionLogFile(), {});
            const otherBuckets = [...new Set(others.map((e) => e.userId))].filter((u) => u !== user);
            if (otherBuckets.length > 0) {
              suffix =
                ` for '${user}' — ${others.length.toString()} under other bucket(s) ` +
                `(${otherBuckets.slice(0, 3).join(", ")}${otherBuckets.length > 3 ? ", …" : ""}); try \`--user all\``;
            }
          }
          io.stdout(`No recorded actions${suffix}.\n`);
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

  actions
    .command("encrypt")
    .description("Encrypt the action log at rest (AES-256-GCM; key = MUSE_MEMORY_KEY or per-host)")
    .option("--json", "Emit a structured result")
    .action(async (options: { readonly json?: boolean }) => {
      const file = actionLogFile();
      const result = await encryptActionLogAtRest(file);
      if (options.json) {
        io.stdout(`${JSON.stringify({ encrypted: true, file, ...result }, null, 2)}\n`);
        return;
      }
      if (result.alreadyEncrypted) {
        io.stdout(`Action log is already encrypted at rest (${file}).\n`);
        return;
      }
      io.stdout(
        `Encrypted action log at rest: ${file}\n` +
        (result.backupPath
          ? `Plaintext backup saved: ${result.backupPath}\n` +
            `  ⚠ This backup is CLEARTEXT — it holds your full action history unencrypted.\n` +
            `  Delete it once you've confirmed 'muse actions' still works with your key.\n`
          : "") +
        `Set MUSE_MEMORY_KEY to a stable secret so the key survives a host/user change.\n`
      );
    });

  actions
    .command("decrypt")
    .description("Revert the action log to plaintext at rest")
    .option("--json", "Emit a structured result")
    .action(async (options: { readonly json?: boolean }) => {
      const file = actionLogFile();
      const result = await decryptActionLogAtRest(file);
      if (options.json) {
        io.stdout(`${JSON.stringify({ encrypted: false, file, ...result }, null, 2)}\n`);
        return;
      }
      io.stdout(
        result.alreadyPlaintext
          ? `Action log is already plaintext at rest (${file}).\n`
          : `Reverted action log to plaintext at rest: ${file}\n`
      );
    });

  actions
    .command("encryption-status")
    .description("Report whether the action log is encrypted at rest (no key needed)")
    .option("--json", "Emit a structured result")
    .action(async (options: { readonly json?: boolean }) => {
      const file = actionLogFile();
      const encrypted = await isActionLogEncrypted(file);
      if (options.json) {
        io.stdout(`${JSON.stringify({ encrypted, file }, null, 2)}\n`);
        return;
      }
      io.stdout(`Action log at rest: ${encrypted ? "ENCRYPTED" : "plaintext"} (${file})\n`);
    });
}
