/**
 * `muse approvals` — the live worklist of state-changing actions Muse
 * attempted over a channel (Telegram/etc.) and the fail-closed gate
 * refused, awaiting your approval. Distinct from `muse actions`: that's
 * the immutable audit log of every action ever attempted; this shows
 * only the un-expired, un-actioned items (with the structured tool +
 * args), and lets you dismiss stale ones. Local read over the shared
 * `~/.muse/pending-approvals.json` the API server's inbound gate writes.
 */

import { resolvePendingApprovalsFile } from "@muse/autoconfigure";
import type { HostLookup } from "@muse/domain-tools";
import { clearPendingApproval, listPendingApprovals, type PendingApproval } from "@muse/messaging";
import type { JsonObject } from "@muse/shared";
import type { Command } from "commander";

import { buildActuatorTools } from "./actuator-tools.js";
import { commandErrorLine } from "./format-cli-error.js";
import type { ProgramIO } from "./program.js";

export interface ApproveResult {
  readonly status: "ran" | "declined" | "not-found" | "no-tool";
  readonly tool?: string;
  readonly detail?: string;
}

/**
 * Re-run a pending channel approval's gated tool through the same proven
 * actuator orchestration (with a confirm gate), then clear it on success
 * so a second approve can't re-fire (replay-guard). Pure-ish: the tool
 * builder's `confirmAction` / `fetchImpl` are injectable for tests.
 */
export async function approvePendingApproval(opts: {
  readonly pendingFile: string;
  readonly id: string;
  readonly env: Record<string, string | undefined>;
  readonly io: ProgramIO;
  readonly confirmAction?: (message: string) => Promise<boolean>;
  /** Injectable TTY check (tests). Headless approve stays fail-close per outbound-safety. */
  readonly isInteractive?: () => boolean;
  readonly fetchImpl?: typeof fetch;
  /** DNS resolver for the web_action SSRF guard (tests inject a fake public resolver). */
  readonly lookup?: HostLookup;
  readonly now?: () => Date;
}): Promise<ApproveResult> {
  const id = opts.id.trim();
  const pending = await listPendingApprovals(opts.pendingFile, opts.now);
  const entry = pending.find((e) => e.id === id);
  if (!entry) {
    return { status: "not-found" };
  }
  const tools = buildActuatorTools({
    env: opts.env,
    io: opts.io,
    userId: entry.userId ?? `${entry.providerId}:${entry.source}`,
    ...(opts.confirmAction ? { confirmAction: opts.confirmAction } : {}),
    ...(opts.isInteractive ? { isInteractive: opts.isInteractive } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.lookup ? { lookup: opts.lookup } : {})
  });
  const tool = tools.find((t) => t.definition.name === entry.tool);
  if (!tool) {
    return { status: "no-tool", tool: entry.tool };
  }
  const result = await tool.execute(entry.arguments as JsonObject, { runId: `approve-${entry.id}` });
  const resultRecord: Record<string, unknown> = {};
  if (result && typeof result === "object" && !Array.isArray(result)) {
    for (const [key, value] of Object.entries(result)) {
      if (typeof key === "string") {
        resultRecord[key] = value;
      }
    }
  }
  const ran = resultRecord["sent"] === true || resultRecord["performed"] === true;
  if (ran) {
    // Replay-guard: only a successful run clears the pending entry; a
    // declined confirm leaves it so the user can approve later.
    await clearPendingApproval(opts.pendingFile, entry.id, opts.now);
    return { status: "ran", tool: entry.tool };
  }
  return { status: "declined", tool: entry.tool, ...(typeof resultRecord["reason"] === "string" ? { detail: resultRecord["reason"] } : {}) };
}

function pendingFile(): string {
  return resolvePendingApprovalsFile(process.env);
}

function formatPending(entry: PendingApproval): string {
  const who = entry.userId ?? `${entry.providerId}:${entry.source}`;
  return `${entry.id}  ${who}  ${entry.tool} — ${entry.draft} (expires ${entry.expiresAt})`;
}

export function registerApprovalsCommands(program: Command, io: ProgramIO): void {
  const approvals = program
    .command("approvals")
    .description("Outbound action worklist — confirm/dismiss draft-first sends awaiting your OK (for tool-call trust see `muse approval`)");

  approvals
    .command("list", { isDefault: true })
    .description("List un-expired pending channel approvals, newest first")
    .option("--json", "Print the raw payload instead of the formatted list")
    .action(async (options: { readonly json?: boolean }) => {
      const pending = await listPendingApprovals(pendingFile());
      if (options.json) {
        io.stdout(`${JSON.stringify({ pending, total: pending.length }, null, 2)}\n`);
        return;
      }
      if (pending.length === 0) {
        io.stdout("No pending approvals.\n");
        return;
      }
      for (const entry of pending) {
        io.stdout(`${formatPending(entry)}\n`);
      }
    });

  approvals
    .command("approve")
    .description("Approve a pending channel action by id — re-runs its gated tool after you confirm the exact draft, then dismisses it")
    .argument("<id>", "Pending approval id (from `muse approvals list`)")
    .action(async (id: string, _options, command: Command) => {
      const result = await approvePendingApproval({
        env: process.env,
        id,
        io,
        pendingFile: pendingFile()
      });
      switch (result.status) {
        case "ran":
          io.stdout(`Ran ${result.tool ?? "action"} and dismissed the pending approval.\n`);
          return;
        case "declined":
          io.stderr(commandErrorLine("approvals approve", `Not run${result.detail ? ` (${result.detail})` : ""} — still pending.`));
          command.error("approvals approve declined", { exitCode: 1 });
          return;
        case "no-tool":
          io.stderr(commandErrorLine("approvals approve", `Cannot re-run '${result.tool ?? "?"}' from approvals — not a known actuator, or its provider isn't configured.`));
          command.error("approvals approve failed", { exitCode: 1 });
          return;
        default:
          io.stderr(commandErrorLine("approvals approve", `No pending approval with id '${id.trim()}' (it may have expired).`));
          command.error("approvals approve failed", { exitCode: 1 });
      }
    });

  approvals
    .command("clear")
    .description("Dismiss a pending approval by id (also prunes expired entries)")
    .argument("<id>", "Pending approval id (from `muse approvals list`)")
    .action(async (id: string, _options, command: Command) => {
      const removed = await clearPendingApproval(pendingFile(), id.trim());
      if (removed) {
        io.stdout(`Dismissed pending approval ${id.trim()}.\n`);
        return;
      }
      io.stderr(commandErrorLine("approvals clear", `No pending approval with id '${id.trim()}'.`));
      command.error("approvals clear failed", { exitCode: 1 });
    });
}
