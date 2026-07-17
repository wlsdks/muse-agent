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
  beginPendingApprovalExecution,
  classifyPendingApprovalToolOutcome,
  claimPendingApproval,
  clearPendingApproval,
  declinePendingApprovalClaim,
  finalizePendingApprovalExecution,
  listPendingApprovals,
  type PendingApproval,
  type PendingApprovalExecutionState
} from "@muse/messaging";
import type { JsonObject } from "@muse/shared";
import { confirm, isCancel } from "@clack/prompts";
import type { Command } from "commander";

import { buildActuatorTools } from "./actuator-tools.js";
import { commandErrorLine } from "./format-cli-error.js";
import type { ProgramIO } from "./program.js";

export interface ApproveResult {
  readonly status: "ran" | "declined" | "not-found" | "no-tool" | "unknown" | "conflict";
  readonly tool?: string;
  readonly detail?: string;
  readonly state?: PendingApprovalExecutionState | "not-found" | "expired" | "forbidden";
}

function conflictResult(tool: string, state: NonNullable<ApproveResult["state"]>, detail?: string): ApproveResult {
  return { ...(detail ? { detail } : {}), state, status: "conflict", tool };
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
  /** Fault-injection seam for proving effect-before-finalize replay safety. */
  readonly finalizeExecution?: typeof finalizePendingApprovalExecution;
  /** Fault-injection seam for proving claim-snapshot race safety. */
  readonly claimApproval?: typeof claimPendingApproval;
  readonly beginExecution?: typeof beginPendingApprovalExecution;
  readonly declineClaim?: typeof declinePendingApprovalClaim;
  /** Tool-result seam for contradictory/failure-shaped result tests. */
  readonly executeTool?: (
    tool: ReturnType<typeof buildActuatorTools>[number],
    arguments_: JsonObject,
    context: { readonly runId: string }
  ) => Promise<unknown>;
}): Promise<ApproveResult> {
  const id = opts.id.trim();
  const pending = await listPendingApprovals(opts.pendingFile, opts.now);
  const entry = pending.find((e) => e.id === id);
  if (!entry) {
    return { status: "not-found" };
  }
  const buildTools = (userId: string) => buildActuatorTools({
      env: opts.env,
      io: opts.io,
      userId,
      confirmAction: async () => true,
      isInteractive: () => true,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.lookup ? { lookup: opts.lookup } : {})
    });
  const tool = buildTools(entry.userId ?? `${entry.providerId}:${entry.source}`).find((candidate) => candidate.definition.name === entry.tool);
  if (!tool) {
    return { status: "no-tool", tool: entry.tool };
  }
  const claim = await (opts.claimApproval ?? claimPendingApproval)(opts.pendingFile, id, { surface: "cli" }, opts.now);
  if (!claim.claimedByThisCall) {
    return claim.state === "not-found" || claim.state === "expired"
      ? { state: claim.state, status: "not-found" }
      : conflictResult(entry.tool, claim.state);
  }
  const snapshot = claim.approvalSnapshot;
  const claimedTool = buildTools(snapshot.userId ?? `${snapshot.providerId}:${snapshot.source}`)
    .find((candidate) => candidate.definition.name === snapshot.tool);
  if (!claimedTool) {
    const declined = await (opts.declineClaim ?? declinePendingApprovalClaim)(opts.pendingFile, snapshot.id, claim.claimToken, "tool no longer available", opts.now);
    return declined.transitioned
      ? { state: "denied", status: "no-tool", tool: snapshot.tool }
      : conflictResult(snapshot.tool, declined.state, "tool unavailable and denial CAS did not win");
  }
  const interactive = opts.isInteractive ?? (() => Boolean(process.stdout.isTTY && process.stdin.isTTY));
  const confirmAction = opts.confirmAction ?? (async (message: string) => {
    const answer = await confirm({ message });
    return !isCancel(answer) && answer;
  });
  const approved = interactive() && await confirmAction(`Approve ${snapshot.tool}: ${snapshot.draft}?`);
  if (!approved) {
    const declined = await (opts.declineClaim ?? declinePendingApprovalClaim)(opts.pendingFile, snapshot.id, claim.claimToken, "user did not confirm", opts.now);
    return declined.transitioned
      ? { detail: "user did not confirm", state: "denied", status: "declined", tool: snapshot.tool }
      : conflictResult(snapshot.tool, declined.state, "confirmation was declined but denial CAS did not win");
  }
  const begun = await (opts.beginExecution ?? beginPendingApprovalExecution)(opts.pendingFile, snapshot.id, claim.claimToken, opts.now);
  if (!begun.transitioned) {
    return conflictResult(snapshot.tool, begun.state, "execution begin CAS did not win");
  }
  let result: unknown;
  const finalizeExecution = opts.finalizeExecution ?? finalizePendingApprovalExecution;
  try {
    result = (await (opts.executeTool ?? ((tool, arguments_, context) => tool.execute(arguments_, context)))(
      claimedTool,
      snapshot.arguments as JsonObject,
      { runId: `approve-${snapshot.id}` }
    ));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const finalized = await finalizeExecution(opts.pendingFile, snapshot.id, claim.claimToken, "unknown", detail, opts.now);
    return finalized.transitioned
      ? { detail, state: "unknown", status: "unknown", tool: snapshot.tool }
      : conflictResult(snapshot.tool, finalized.state, `tool threw (${detail}) and unknown finalization CAS did not win`);
  }
  if (classifyPendingApprovalToolOutcome(result) === "succeeded") {
    const finalized = await finalizeExecution(opts.pendingFile, snapshot.id, claim.claimToken, "succeeded", undefined, opts.now);
    if (!finalized.transitioned) {
      return conflictResult(snapshot.tool, finalized.state, "success finalization CAS did not win");
    }
    return { state: "succeeded", status: "ran", tool: snapshot.tool };
  }
  const detail = "tool did not prove success";
  const finalized = await finalizeExecution(opts.pendingFile, snapshot.id, claim.claimToken, "unknown", detail, opts.now);
  return finalized.transitioned
    ? { detail, state: "unknown", status: "unknown", tool: snapshot.tool }
    : conflictResult(snapshot.tool, finalized.state, "unknown finalization CAS did not win");
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
          io.stderr(commandErrorLine("approvals approve", `Approval state changed to '${result.state ?? "unknown"}' before this command could finish${result.detail ? ` (${result.detail})` : ""}; no additional retry will be attempted.`));
          command.error("approvals approve state conflict", { exitCode: 1 });
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
