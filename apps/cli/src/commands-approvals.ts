/**
 * `muse approvals` — the live worklist of state-changing actions Muse
 * attempted over a channel (Telegram/etc.) and the fail-closed gate
 * refused, awaiting your approval. Distinct from `muse actions`: that's
 * the immutable audit log of every action ever attempted; this shows
 * only the un-expired, un-actioned items (with the structured tool +
 * args), and lets you durably deny stale ones. Local read over the shared
 * `~/.muse/pending-approvals.json` the API server's inbound gate writes.
 */

import { resolvePendingApprovalsFile } from "@muse/autoconfigure";
import type { HostLookup } from "@muse/domain-tools";
import {
  clearPendingApproval,
  completePendingApproval,
  listPendingApprovals,
  type CompletePendingApprovalResult,
  type PendingApproval,
  type PendingApprovalCoordinatorOperations,
  type PendingApprovalCoordinatorPhase,
  type PendingApprovalCoordinatorState
} from "@muse/messaging";
import type { JsonObject } from "@muse/shared";
import { confirm, isCancel } from "@clack/prompts";
import type { Command } from "commander";

import { buildActuatorTools } from "./actuator-tools.js";
import { commandErrorLine } from "./format-cli-error.js";
import type { ProgramIO } from "./program.js";

export interface ApproveResult {
  readonly status: "ran" | "declined" | "not-found" | "no-tool" | "unknown" | "conflict" | "persistence-uncertain";
  readonly tool?: string;
  readonly detail?: string;
  readonly state?: PendingApprovalCoordinatorState;
  readonly phase?: PendingApprovalCoordinatorPhase;
  readonly effectAttempted?: boolean;
  readonly certainty?: "observed" | "unobserved";
}

function mapCoordinatorResult(result: CompletePendingApprovalResult): ApproveResult {
  switch (result.kind) {
    case "unavailable":
      return { state: result.state, status: "not-found" };
    case "conflict":
      return { phase: result.phase, state: result.state, status: "conflict" };
    case "denied":
      return result.detail === "tool no longer available"
        ? { detail: result.detail, state: "denied", status: "no-tool", tool: result.approvalSnapshot.tool }
        : { detail: result.detail, state: "denied", status: "declined", tool: result.approvalSnapshot.tool };
    case "unknown":
      return { detail: result.detail, effectAttempted: result.effectAttempted, state: "unknown", status: "unknown", tool: result.approvalSnapshot.tool };
    case "succeeded":
      return { state: "succeeded", status: "ran", tool: result.approvalSnapshot.tool };
    case "persistence-uncertain":
      return {
        certainty: result.certainty,
        detail: result.error,
        effectAttempted: result.effectAttempted,
        phase: result.phase,
        ...(result.certainty === "observed" ? { state: result.state } : {}),
        status: "persistence-uncertain"
      };
  }
}

/**
 * Re-run a pending channel approval's gated tool through the same proven
 * actuator orchestration (with a confirm gate), then record its terminal
 * result so a second approve can't re-fire (replay-guard). Pure-ish: the tool
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
  readonly coordinatorOperations?: PendingApprovalCoordinatorOperations;
  /** Tool-result seam for contradictory/failure-shaped result tests. */
  readonly executeTool?: (
    tool: ReturnType<typeof buildActuatorTools>[number],
    arguments_: JsonObject,
    context: { readonly runId: string }
  ) => Promise<unknown>;
}): Promise<ApproveResult> {
  const id = opts.id.trim();
  const interactive = opts.isInteractive ?? (() => Boolean(process.stdout.isTTY && process.stdin.isTTY));
  const confirmAction = opts.confirmAction ?? (async (message: string) => {
    const answer = await confirm({ message });
    return !isCancel(answer) && answer;
  });
  const result = await completePendingApproval({
    actor: { surface: "cli" },
    file: opts.pendingFile,
    id,
    now: opts.now,
    operations: opts.coordinatorOperations,
    prepare: async (snapshot) => {
      const tools = buildActuatorTools({
        env: opts.env,
        io: opts.io,
        userId: snapshot.userId ?? `${snapshot.providerId}:${snapshot.source}`,
        confirmAction: async () => true,
        isInteractive: () => true,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.lookup ? { lookup: opts.lookup } : {})
      });
      const tool = tools.find((candidate) => candidate.definition.name === snapshot.tool);
      if (!tool) {
        return { detail: "tool no longer available", kind: "decline" };
      }
      if (!(interactive() && await confirmAction(`Approve ${snapshot.tool}: ${snapshot.draft}?`))) {
        return { detail: "user did not confirm", kind: "decline" };
      }
      return {
        execute: async () => (opts.executeTool ?? ((selected, arguments_, context) => selected.execute(arguments_, context)))(
          tool,
          snapshot.arguments as JsonObject,
          { runId: `approve-${snapshot.id}` }
        ),
        kind: "execute"
      };
    }
  });
  return mapCoordinatorResult(result);
}

function pendingFile(): string {
  return resolvePendingApprovalsFile(process.env as Record<string, string | undefined>);
}

function formatPending(entry: PendingApproval): string {
  const who = entry.userId ?? `${entry.providerId}:${entry.source}`;
  return `${entry.id}  ${who}  ${entry.tool} — ${entry.draft} (expires ${entry.expiresAt})`;
}

export function registerApprovalsCommands(
  program: Command,
  io: ProgramIO,
  deps: { readonly approvePendingApproval?: typeof approvePendingApproval } = {}
): void {
  const approve = deps.approvePendingApproval ?? approvePendingApproval;
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
    .description("Approve a pending channel action by id — confirms the exact draft, records its outcome, and blocks replay")
    .argument("<id>", "Pending approval id (from `muse approvals list`)")
    .action(async (id: string, _options, command: Command) => {
      const result = await approve({
        env: process.env as Record<string, string | undefined>,
        id,
        io,
        pendingFile: pendingFile()
      });
      switch (result.status) {
        case "ran":
          io.stdout(`Completed ${result.tool ?? "action"} and recorded the result; replay is blocked.\n`);
          return;
        case "declined":
          io.stderr(commandErrorLine("approvals approve", `Denied${result.detail ? ` (${result.detail})` : ""}; this approval will not retry automatically.`));
          command.error("approvals approve declined", { exitCode: 1 });
          return;
        case "no-tool":
          io.stderr(commandErrorLine("approvals approve", `Cannot re-run '${result.tool ?? "?"}' from approvals — not a known actuator, or its provider isn't configured.`));
          command.error("approvals approve failed", { exitCode: 1 });
          return;
        case "unknown":
          io.stderr(commandErrorLine("approvals approve", `Outcome unknown for '${result.tool ?? "?"}'${result.detail ? ` (${result.detail})` : ""}; it will not be retried automatically.`));
          command.error("approvals approve outcome unknown", { exitCode: 1 });
          return;
        case "conflict":
          io.stderr(commandErrorLine(
            "approvals approve",
            result.phase === "finalize"
              ? `Action may have run, but approval finalization did not win; durable state is '${result.state ?? "unknown"}'; no retry will be attempted.`
              : `Approval state changed to '${result.state ?? "unknown"}' before this command could finish${result.detail ? ` (${result.detail})` : ""}; no additional retry will be attempted.`
          ));
          command.error("approvals approve state conflict", { exitCode: 1 });
          return;
        case "persistence-uncertain":
          io.stderr(commandErrorLine("approvals approve", `Approval persistence is uncertain during '${result.phase ?? "unknown"}'${result.state ? ` (observed state: ${result.state})` : ""}${result.detail ? `: ${result.detail}` : ""}; no automatic retry will be attempted.`));
          command.error("approvals approve persistence uncertain", { exitCode: 1 });
          return;
        default:
          io.stderr(commandErrorLine("approvals approve", `No pending approval with id '${id.trim()}' (it may have expired).`));
          command.error("approvals approve failed", { exitCode: 1 });
      }
    });

  approvals
    .command("clear")
    .description("Deny a pending approval by id and durably block retry")
    .argument("<id>", "Pending approval id (from `muse approvals list`)")
    .action(async (id: string, _options, command: Command) => {
      const removed = await clearPendingApproval(pendingFile(), id.trim());
      if (removed) {
        io.stdout(`Denied pending approval ${id.trim()}; it will not retry.\n`);
        return;
      }
      io.stderr(commandErrorLine("approvals clear", `No pending approval with id '${id.trim()}'.`));
      command.error("approvals clear failed", { exitCode: 1 });
    });
}
