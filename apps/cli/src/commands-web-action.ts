/**
 * `muse web-action` — perform a state-changing web request (submit a
 * form, book) only after you confirm the EXACT action
 * (`.claude/rules/outbound-safety.md`). Never autonomous; absent
 * confirmation nothing fires. Gating lives in
 * `performWebActionWithApproval` (@muse/mcp); this is the surface.
 *
 * NOT for banking / payments — out of scope per outbound-safety.
 */

import { resolveActionLogFile } from "@muse/autoconfigure";
import { performWebActionWithApproval, type WebActionApprovalGate } from "@muse/domain-tools";
import { confirm, isCancel } from "@clack/prompts";
import type { Command } from "commander";

import { confirmBoolean } from "./confirm-boolean.js";
import type { ProgramIO } from "./program.js";

interface RunOptions {
  readonly url?: string;
  readonly method?: string;
  readonly body?: string;
  readonly summary?: string;
  readonly user?: string;
}

export interface WebActionCommandDeps {
  readonly approvalGate?: WebActionApprovalGate;
  readonly fetchImpl?: typeof fetch;
  readonly actionLogFile?: string;
}

export function registerWebActionCommands(program: Command, io: ProgramIO, deps: WebActionCommandDeps = {}): void {
  program
    .command("web-action")
    .description("Perform a confirmation-gated web action (submit/book). Never autonomous; not for payments.")
    .requiredOption("--url <url>", "Target URL")
    .requiredOption("--summary <text>", "Human description of what this does (shown for confirmation)")
    .option("--method <verb>", "HTTP method", "POST")
    .option("--body <json>", "Request body")
    .option("--user <id>", "User identity for the action log", "stark")
    .action(async (options: RunOptions) => {
      const request = {
        method: (options.method ?? "POST").toUpperCase(),
        url: options.url ?? "",
        ...(options.body !== undefined ? { body: options.body } : {})
      };
      const gate: WebActionApprovalGate = deps.approvalGate ?? (async (action) => {
        io.stdout(`\n${action.summary}\n${action.request.method ?? "POST"} ${action.request.url}\n${action.request.body ? `${action.request.body}\n` : ""}\n`);
        const approved = await confirmBoolean(confirm, isCancel, "Perform this web action?");
        return approved ? { approved: true } : { approved: false, reason: "user did not confirm" };
      });

      const outcome = await performWebActionWithApproval({
        actionLogFile: deps.actionLogFile ?? resolveActionLogFile(process.env),
        approvalGate: gate,
        fetchImpl: deps.fetchImpl ?? globalThis.fetch,
        request,
        summary: options.summary ?? "",
        userId: options.user ?? "stark"
      });

      if (outcome.performed) {
        io.stdout(`Done (HTTP ${outcome.status.toString()}).\n`);
        return;
      }
      io.stderr(`Not performed (${outcome.reason}): ${outcome.detail}\n`);
      process.exitCode = 1;
    });
}
