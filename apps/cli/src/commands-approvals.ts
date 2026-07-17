/**
 * `muse approvals` — the live worklist of state-changing actions Muse
 * attempted over a channel (Telegram/etc.) and the fail-closed gate
 * refused, awaiting your approval. Distinct from `muse actions`: that's
 * the immutable audit log of every action ever attempted; this shows
 * only the un-expired, un-actioned items (with the structured tool +
 * args), and lets you durably deny stale ones. Local read over the shared
 * `~/.muse/pending-approvals.json` the API server's inbound gate writes.
 */

import { resolvePendingApprovalsFile, resolveTasksFile } from "@muse/autoconfigure";
import { createTasksMcpServer, normalizeLocalTaskMutationOutcome, type HostLookup } from "@muse/domain-tools";
import { createLoopbackMcpMuseTools } from "@muse/mcp";
import {
  clearPendingApproval,
  completePendingApproval,
  inspectPendingApprovalStatus,
  listPendingApprovals,
  type CompletePendingApprovalResult,
  type PendingApprovalAcquisition,
  type PendingApproval,
  type PendingApprovalCoordinatorOperations,
  type PendingApprovalCoordinatorPhase,
  type PendingApprovalCoordinatorState
} from "@muse/messaging";
import type { JsonObject } from "@muse/shared";
import type { MuseTool, ToolExecutionValue } from "@muse/tools";
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
export interface ApprovePendingApprovalOptions {
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
  readonly acquisition?: PendingApprovalAcquisition;
  readonly coordinatorOperations?: PendingApprovalCoordinatorOperations;
  readonly resolveTool?: (name: string) => MuseTool | undefined;
  /** Tool-result seam for contradictory/failure-shaped result tests. */
  readonly executeTool?: (
    tool: MuseTool,
    arguments_: JsonObject,
    context: { readonly runId: string }
  ) => Promise<unknown>;
}

export async function approvePendingApproval(opts: ApprovePendingApprovalOptions): Promise<ApproveResult> {
  const id = opts.id.trim();
  const interactive = opts.isInteractive ?? (() => Boolean(process.stdout.isTTY && process.stdin.isTTY));
  const confirmAction = opts.confirmAction ?? (async (message: string) => {
    const answer = await confirm({ message });
    return !isCancel(answer) && answer;
  });
  const result = await completePendingApproval({
    acquisition: opts.acquisition,
    actor: { surface: "cli" },
    file: opts.pendingFile,
    id,
    now: opts.now,
    operations: opts.coordinatorOperations,
    prepare: async (snapshot) => {
      const tool = opts.resolveTool?.(snapshot.tool) ?? (opts.resolveTool === undefined
        ? buildActuatorTools({
            env: opts.env,
            io: opts.io,
            userId: snapshot.userId ?? `${snapshot.providerId}:${snapshot.source}`,
            confirmAction: async () => true,
            isInteractive: () => true,
            ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
            ...(opts.lookup ? { lookup: opts.lookup } : {})
          }).find((candidate) => candidate.definition.name === snapshot.tool)
        : undefined);
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

/** Explicitly recover only the existing local loopback task actuators. */
export async function recoverPendingApproval(
  opts: Omit<ApprovePendingApprovalOptions, "acquisition" | "resolveTool">
): Promise<ApproveResult> {
  const tools = createLoopbackMcpMuseTools(createTasksMcpServer({
    file: resolveTasksFile(opts.env),
    ...(opts.now ? { now: opts.now } : {})
  })).filter((tool) => tool.definition.name === "muse.tasks.add" || tool.definition.name === "muse.tasks.complete");
  const recoverableTools = tools.map((tool): MuseTool => ({
    ...tool,
    execute: async (arguments_, context): Promise<ToolExecutionValue> => normalizeLocalTaskMutationOutcome(
      tool.definition.name,
      await tool.execute(arguments_, context) as ToolExecutionValue
    )
  }));
  return approvePendingApproval({
    ...opts,
    acquisition: "recover-stale-claim",
    resolveTool: (name) => recoverableTools.find((tool) => tool.definition.name === name)
  });
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
  deps: {
    readonly approvePendingApproval?: typeof approvePendingApproval;
    readonly recoverPendingApproval?: typeof recoverPendingApproval;
    readonly inspectPendingApprovalStatus?: typeof inspectPendingApprovalStatus;
  } = {}
): void {
  const approve = deps.approvePendingApproval ?? approvePendingApproval;
  const recover = deps.recoverPendingApproval ?? recoverPendingApproval;
  const inspect = deps.inspectPendingApprovalStatus ?? inspectPendingApprovalStatus;
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
    .command("status")
    .description("Show safe durable metadata for one approval")
    .argument("<id>", "Pending approval id")
    .option("--json", "Print machine-readable status metadata")
    .action(async (id: string, options: { readonly json?: boolean }, command: Command) => {
      const result = await inspect(pendingFile(), id.trim(), { surface: "cli" });
      if (!result.found) {
        io.stderr(commandErrorLine("approvals status", `No approval status for id '${id.trim()}' (state: ${result.state}).`));
        command.error("approvals status failed", { exitCode: 1 });
        return;
      }
      if (options.json) {
        io.stdout(`${JSON.stringify(result.status, null, 2)}\n`);
        return;
      }
      const status = result.status;
      io.stdout(`${status.id}  ${status.tool}  state=${status.state}  recoverable=${String(status.recoverable)}  effectMayHaveOccurred=${String(status.effectMayHaveOccurred)}\n`);
      if (status.recoverableAt) io.stdout(`recoverableAt=${status.recoverableAt}\n`);
      if (status.draft) io.stdout(`draft=${status.draft}\n`);
    });

  approvals
    .command("recover")
    .description("Explicitly recover a stale pre-effect local task claim")
    .argument("<id>", "Claimed approval id")
    .option("--json", "Print the coordinator result as JSON")
    .action(async (id: string, options: { readonly json?: boolean }, command: Command) => {
      const result = await recover({
        env: process.env as Record<string, string | undefined>,
        id,
        io,
        pendingFile: pendingFile()
      });
      if (options.json) {
        io.stdout(`${JSON.stringify(result)}\n`);
        if (result.status === "ran") return;
        command.error("approvals recover failed", { exitCode: 1 });
        return;
      }
      switch (result.status) {
        case "ran":
          io.stdout(`Recovered and completed ${result.tool ?? "action"}; replay is blocked.\n`);
          return;
        case "declined":
          io.stderr(commandErrorLine("approvals recover", `Recovery denied${result.detail ? ` (${result.detail})` : ""}; it will not retry automatically.`));
          break;
        case "unknown":
          io.stderr(commandErrorLine("approvals recover", `Recovered action outcome is unknown for '${result.tool ?? "?"}'; it will not be retried automatically.`));
          break;
        case "conflict":
          io.stderr(commandErrorLine(
            "approvals recover",
            result.phase === "finalize"
              ? `Action may have run, but recovery finalization did not win; durable state is '${result.state ?? "unknown"}'; no retry will be attempted.`
              : `Approval is not recoverable from state '${result.state ?? "unknown"}'; use normal approval for pending work and never retry executing/terminal work.`
          ));
          break;
        case "persistence-uncertain":
          io.stderr(commandErrorLine("approvals recover", `Recovery persistence is uncertain during '${result.phase ?? "unknown"}'${result.state ? ` (observed state: ${result.state})` : ""}; no retry will be attempted.`));
          break;
        case "no-tool":
          io.stderr(commandErrorLine("approvals recover", `The claimed tool '${result.tool ?? "?"}' is not an available local task actuator.`));
          break;
        default:
          io.stderr(commandErrorLine("approvals recover", `No recoverable approval with id '${id.trim()}'.`));
      }
      command.error("approvals recover failed", { exitCode: 1 });
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
