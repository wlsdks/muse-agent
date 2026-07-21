import { errorMessage } from "@muse/shared";
/**
 * Personal Continuity CLI — deliberately local and deterministic. The user
 * chooses a life/work thread and explicitly links sources; this command never
 * asks a model to infer affiliation, timing, permission, or an external action.
 */

import { isCancel, select } from "@clack/prompts";
import {
  AttunementStoreError,
  CONTINUITY_IMPROVEMENT_COHORT_SIZE,
  CONTINUITY_KILL_CRITERION_FIRST_PACKS,
  buildContinuityInteractionReport,
  computeContinuityEvaluation,
  createLocalArtifactValidator,
  createLocalContinuityTaskInteractionSourceResolver,
  createLocalExactArtifactResolver,
  createPersonalThread,
  deletePersonalThread,
  inspectThread,
  linkArtifact,
  mcpProviderId,
  prepareContinuityPack,
  prepareContinuityReview,
  readAttunementState,
  resetThreadPolicy,
  undoThreadReset,
  unlinkArtifact,
  type ArtifactLink,
  type ArtifactLinkValidator,
  type AttunementState,
  type ContinuityEvaluation,
  type ContinuityFeedbackCohort as CoreContinuityFeedbackCohort,
  type ContinuityImprovementGate as CoreContinuityImprovementGate,
  type ContinuityKindEvaluation,
  type ContinuityLongitudinalKindCoverage,
  type ContinuityReview,
  type ContinuityReviewItem,
  type ContinuityOutcome,
  type ContinuityPack,
  type ExactArtifactResolver,
  type PersonalThread,
  type PersonalThreadKind,
} from "@muse/attunement";
import { openProductionAuthorizedContinuityPack, recordProductionAuthorizedContinuityOutcome } from "@muse/attunement/host";
import { resolveAttunementFile, resolveNotesDir, resolveRemindersFile, resolveTasksFile } from "@muse/autoconfigure";
import type { Command } from "commander";

import {
  resolveMcpResourceArtifact,
  serverFromProviderId,
  validateMcpResource,
  type McpToolCaller
} from "./attunement-mcp-resource.js";
import type { ProgramIO } from "./program.js";

const THREAD_KINDS = ["life", "work"] as const;
const ARTIFACT_TYPES = ["task", "note", "reminder", "resource"] as const;
const ARTIFACT_ROLES = ["context", "next-step"] as const;
const OUTCOMES = ["used", "adjusted", "ignored", "rejected"] as const;

export interface AttunementCommandDeps {
  /**
   * Calls a READ tool on a connected MCP server so a `resource` link can be
   * validated / resolved. Defaults to a lazily-built live McpManager; tests
   * inject a contract-faithful fake. Absent runtime ⇒ resource linking fails
   * closed with a "connect the MCP server first" message.
   */
  readonly mcpResourceCaller?: McpToolCaller;
  /** One Pack captures this clock exactly once for deterministic due-state rendering. */
  readonly now?: () => number;
}

function environment(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}

function attunementFile(): string {
  return resolveAttunementFile(environment());
}

function tasksFile(): string {
  return resolveTasksFile(environment());
}

function remindersFile(): string {
  return resolveRemindersFile(environment());
}

function notesDir(): string {
  return resolveNotesDir(environment());
}

function assertChoice(value: string, allowed: readonly string[], name: string): void {
  if (!allowed.includes(value)) throw new AttunementStoreError(`${name} must be one of: ${allowed.join(", ")}`);
}

/**
 * The store refuses unvalidated links. This adapter is the only place that
 * knows the local task/note/reminder adapters and the external MCP resource provider,
 * so it returns their exact, canonical identifiers rather than trusting a CLI
 * argument. A `resource` is confirmed to exist on its named, connected MCP
 * server before any link is stored.
 */
function createArtifactValidator(mcpCaller: McpToolCaller | undefined): ArtifactLinkValidator {
  const localValidator = createLocalArtifactValidator({
    notesDir: notesDir(),
    remindersFile: remindersFile(),
    tasksFile: tasksFile()
  });
  return async ({ artifactId, artifactType, providerId }) => {
    if (artifactType === "resource") {
      const server = serverFromProviderId(providerId);
      const resolved = await validateMcpResource(server, artifactId, mcpCaller);
      return { artifactId: resolved.artifactId, artifactType, providerId: resolved.providerId };
    }
    return localValidator({ artifactId, artifactType, providerId });
  };
}

function createResolveExactArtifact(mcpCaller: McpToolCaller | undefined): ExactArtifactResolver {
  const resolveLocal = createLocalExactArtifactResolver({
    notesDir: notesDir(),
    remindersFile: remindersFile(),
    tasksFile: tasksFile()
  });
  return async (link) => {
    if (link.artifactType === "resource") {
      // The resolved title/summary is UNTRUSTED external text; it is displayed
      // as evidence and never elevated to a Muse-authored fact. Any failure ⇒
      // undefined ⇒ `unavailable`, never a fabricated placeholder.
      return resolveMcpResourceArtifact(serverFromProviderId(link.providerId), link.artifactId, link.role, mcpCaller);
    }
    return resolveLocal(link);
  };
}

/**
 * Lazily build a live MCP tool caller from the runtime assembly, so a resource
 * link/resolve reaches a connected server. Kept out of the module top level
 * (heavy runtime import) and only constructed when a resource operation runs.
 * Any inability to reach the server surfaces as a fail-closed error (link) or
 * `unavailable` (display), never a fabricated resource.
 */
function defaultMcpResourceCaller(): McpToolCaller {
  return async (server, toolName, args) => {
    const { createMuseRuntimeAssembly, seedExternalMcpServers } = await import("@muse/autoconfigure");
    const assembly = createMuseRuntimeAssembly();
    const manager = assembly.mcp.manager;
    if (!manager.isExternalTransportAllowed()) {
      throw new AttunementStoreError(
        `external MCP transport is disabled (local-only mode); cannot link a resource from '${server}'`
      );
    }
    await seedExternalMcpServers(assembly.mcp.serverStore, assembly.mcp.externalServerInputs);
    await manager.initializeFromStore();
    if (manager.getStatus(server) !== "connected") {
      await manager.connect(server);
    }
    const tool = manager.toMuseTools().find((candidate) => candidate.definition.name === `${server}.${toolName}`);
    if (!tool) {
      throw new AttunementStoreError(
        `connect the MCP server '${server}' first — tool '${toolName}' is not available (run \`muse mcp connect ${server}\`)`
      );
    }
    return tool.execute(args as never, { runId: `attunement_resource_${Date.now().toString()}`, userId: "owner" });
  };
}

/**
 * Parse `muse thread link <id> resource <server>/<resource-id>` into a link
 * input. A resource is context-only (an external artifact can never be the
 * next thing YOU do), so next-step is rejected here with a clear message.
 */
function buildResourceLinkInput(rawArtifactId: string, role: ArtifactLink["role"], threadId: string): {
  readonly artifactId: string;
  readonly artifactType: ArtifactLink["artifactType"];
  readonly providerId: string;
  readonly role: ArtifactLink["role"];
  readonly threadId: string;
} {
  if (role === "next-step") {
    throw new AttunementStoreError(
      "a resource is context-only; an external artifact cannot be a next-step (the next step stays a local open task)"
    );
  }
  const separator = rawArtifactId.indexOf("/");
  const server = separator > 0 ? rawArtifactId.slice(0, separator).trim() : "";
  const resourceId = separator > 0 ? rawArtifactId.slice(separator + 1).trim() : "";
  if (!server || !resourceId) {
    throw new AttunementStoreError(
      "a resource must be '<server>/<resource-id>', e.g. github/facebook/react/issues/123"
    );
  }
  return { artifactId: resourceId, artifactType: "resource", providerId: mcpProviderId(server), role, threadId };
}

export type ContinuityFeedbackCohort = CoreContinuityFeedbackCohort;
export type ContinuityImprovementGate = CoreContinuityImprovementGate;
export type ContinuityKindStats = ContinuityKindEvaluation;
export type ContinuityStats = ContinuityEvaluation;

interface CliContinuityReview extends Omit<ContinuityReview, "next"> {
  readonly next?: ContinuityReviewItem & {
    readonly outcomeCommands: Readonly<Record<ContinuityOutcome, string>>;
  };
}

/**
 * Deterministic per-outcome accounting over all deliveries + a "first 20 packs"
 * window — the kill-criterion instrument (used<20% or rejected>30% ⇒ fix pack
 * usefulness before more automation). Reads only persisted deliveries; empty
 * state yields zeros, not a crash.
 */
export function computeContinuityStats(state: AttunementState): ContinuityStats {
  return computeContinuityEvaluation(state);
}

function formatKindStats(kind: PersonalThreadKind, stats: ContinuityKindStats): string[] {
  const { firstPacks, improvementGate, outcomes } = stats;
  return [
    `  ${kind}: ${stats.totalDeliveries.toString()} deliveries (${stats.withOutcome.toString()} with feedback); used ${outcomes.used.toString()}, adjusted ${outcomes.adjusted.toString()}, ignored ${outcomes.ignored.toString()}, rejected ${outcomes.rejected.toString()}.`,
    `    First ${CONTINUITY_KILL_CRITERION_FIRST_PACKS.toString()}: used ${firstPacks.used.toString()}/${firstPacks.considered.toString()}, rejected ${firstPacks.rejected.toString()}/${firstPacks.considered.toString()}; automation ${stats.automationGate.status} — ${stats.automationGate.reasons.join("; ")}.`,
    `    Feedback cohorts: first ${CONTINUITY_IMPROVEMENT_COHORT_SIZE.toString()} used ${improvementGate.firstFiveFeedback.used.toString()}/${CONTINUITY_IMPROVEMENT_COHORT_SIZE.toString()}, rejected ${improvementGate.firstFiveFeedback.rejected.toString()}/${CONTINUITY_IMPROVEMENT_COHORT_SIZE.toString()}; next ${CONTINUITY_IMPROVEMENT_COHORT_SIZE.toString()} used ${improvementGate.nextFiveFeedback.used.toString()}/${CONTINUITY_IMPROVEMENT_COHORT_SIZE.toString()}, rejected ${improvementGate.nextFiveFeedback.rejected.toString()}/${CONTINUITY_IMPROVEMENT_COHORT_SIZE.toString()}; trend ${improvementGate.status} — ${improvementGate.reason}.`
  ];
}

function formatLongitudinalCoverage(kind: PersonalThreadKind, coverage: ContinuityLongitudinalKindCoverage): string {
  const feedbackUnit = coverage.remainingFeedback === 1 ? "feedback entry" : "feedback";
  const dateUnit = coverage.remainingDates === 1 ? "date" : "dates";
  return `  ${kind}: feedback ${coverage.explicitFeedback.toString()}/${coverage.explicitFeedbackTarget.toString()} across ${coverage.distinctUtcDates.toString()}/${coverage.distinctUtcDatesTarget.toString()} UTC dates; ${coverage.remainingFeedback.toString()} ${feedbackUnit} and ${coverage.remainingDates.toString()} ${dateUnit} remaining.`;
}

export function formatContinuityStats(stats: ContinuityStats): string {
  const { outcomes, firstPacks } = stats;
  const technical = stats.technicalEvidence.overall;
  const technicalOutcomeCount = Object.values(technical.outcomes)
    .flatMap((byOutcome) => Object.values(byOutcome))
    .reduce((total, count) => total + count, 0);
  const lines = [
    "Production-authorized numeric readiness (organic-authorized evidence; not verified natural behavior):",
    `Continuity outcomes across ${stats.totalDeliveries.toString()} deliveries (${stats.withOutcome.toString()} with feedback):`,
    `  used: ${outcomes.used.toString()}  adjusted: ${outcomes.adjusted.toString()}  ignored: ${outcomes.ignored.toString()}  rejected: ${outcomes.rejected.toString()}`,
    `First ${CONTINUITY_KILL_CRITERION_FIRST_PACKS.toString()} packs: used ${firstPacks.used.toString()}/${firstPacks.considered.toString()}, rejected ${firstPacks.rejected.toString()}/${firstPacks.considered.toString()} (kill criterion: used<20% or rejected>30%)`,
    `Automation gate: ${stats.automationGate.status} — ${stats.automationGate.reasons.join("; ")}.`,
    `Longitudinal evidence: ${stats.longitudinalGate.status} — ${stats.longitudinalGate.reasons.join("; ")}.`,
    formatLongitudinalCoverage("life", stats.longitudinalGate.byKind.life),
    formatLongitudinalCoverage("work", stats.longitudinalGate.byKind.work),
    "By thread kind:",
    ...formatKindStats("life", stats.byKind.life),
    ...formatKindStats("work", stats.byKind.work),
    "All recorded technical evidence (excluded from readiness unless both sides are organic-authorized):",
    `  deliveries: organic=${technical.deliveries.organic.toString()} controlled=${technical.deliveries.controlled.toString()} unclassified=${technical.deliveries.unclassified.toString()}; outcomes=${technicalOutcomeCount.toString()}.`
  ];
  return `${lines.join("\n")}\n`;
}

/** Add only copy-ready CLI commands to the canonical domain review. */
async function prepareCliContinuityReview(
  state: AttunementState,
  resolveExactArtifact: ExactArtifactResolver
): Promise<CliContinuityReview> {
  const review = await prepareContinuityReview(state, resolveExactArtifact);
  if (!review.next) return { progress: review.progress };
  const outcomeCommands = Object.fromEntries(
    OUTCOMES.map((outcome) => [outcome, `muse thread outcome ${review.next!.deliveryId} ${outcome}`])
  ) as Readonly<Record<ContinuityOutcome, string>>;
  return {
    next: {
      ...review.next,
      outcomeCommands,
    },
    progress: review.progress
  };
}

export function formatContinuityReviewQueue(queue: CliContinuityReview): string {
  const { progress } = queue;
  const lines = [
    `First-${progress.target.toString()} Continuity review: ${progress.reviewedDeliveries.toString()}/${progress.eligibleDeliveries.toString()} opened packs have feedback; ${progress.remainingPacks.toString()} more packs still need to be opened.`
  ];
  if (!queue.next) {
    lines.push(progress.remainingPacks > 0
      ? "No opened pack is waiting for feedback. Open the next pack manually with `muse thread continue <thread-id>`."
      : "All first-20 packs have explicit feedback. Inspect `muse thread stats` before changing any automation policy.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`Next unreviewed: ${queue.next.deliveryId} (${queue.next.openedAt})`);
  lines.push(`  ${queue.next.thread.title} [${queue.next.thread.kind}]  ${queue.next.thread.id}`);
  lines.push("  Exact evidence:");
  if (queue.next.evidence.length === 0) lines.push("    - none recorded for this delivery");
  for (const evidence of queue.next.evidence) {
    const prefix = `[${evidence.reference.providerId}:${evidence.reference.artifactType}:${evidence.reference.artifactId}]`;
    lines.push(evidence.artifact
      ? `    - ${prefix} ${evidence.artifact.title}`
      : `    - ${prefix} unavailable`);
  }
  lines.push("Record one honest outcome after reviewing the pack:");
  for (const outcome of OUTCOMES) lines.push(`  ${outcome}: ${queue.next.outcomeCommands[outcome]}`);
  return `${lines.join("\n")}\n`;
}

async function formatThreadReview(state: AttunementState, resolveExactArtifact: ExactArtifactResolver, now: () => number): Promise<string> {
  if (state.threads.length === 0) {
    return "No personal threads yet. Start one with `muse thread start <title> --kind <life|work>`.\n";
  }

  const lines = ["Personal Continuity review:"];
  for (const thread of state.threads) {
    const pack = await prepareContinuityPack(state, thread.id, resolveExactArtifact, { now });
    const availableEvidence = pack.evidence.filter((entry) => entry.status === "available").length;
    const latestFeedback = state.deliveries
      .filter((delivery) => delivery.threadId === thread.id && delivery.outcome)
      .sort((left, right) => right.outcome!.recordedAt.localeCompare(left.outcome!.recordedAt))[0]?.outcome?.outcome;
    const evidence = pack.evidence.length === 0
      ? "evidence: none linked"
      : `evidence: ${availableEvidence.toString()}/${pack.evidence.length.toString()} available`;
    const nextStep = pack.policy.nextStep === "hidden"
      ? "next step: hidden by previous feedback"
      : pack.nextStep
        ? `next step: ${pack.nextStep.title} [${pack.nextStep.artifactId}]`
        : "next step: none set";
    const readiness = pack.evidence.length === 0
      ? {
          action: `link an exact source: muse thread link ${thread.id} <task|note|reminder|resource> <id> --role <context|next-step>`,
          status: "needs-link"
        }
      : availableEvidence === 0
        ? {
            action: `inspect and relink an available source: muse thread inspect ${thread.id}`,
            status: "needs-relink"
          }
        : pack.policy.nextStep === "hidden"
          ? {
              action: `inspect feedback before changing policy: muse thread inspect ${thread.id}`,
              status: "blocked-by-feedback"
            }
          : {
              action: `prepare a pack manually: muse thread continue ${thread.id}`,
              status: "ready"
            };

    lines.push(`  ${thread.id}  [${thread.kind}]  ${thread.title}  (${readiness.status})`);
    lines.push(`    ${evidence}; ${nextStep}${latestFeedback ? `; latest feedback: ${latestFeedback}` : ""}`);
    lines.push(`    manual action: ${readiness.action}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatArtifactMetadata(artifact: NonNullable<ContinuityPack["nextStep"]>): string {
  const metadata: string[] = [];
  if (artifact.taskDueAt && artifact.taskDueState) {
    metadata.push(`${artifact.taskDueState}: ${artifact.taskDueAt}`);
  }
  if (artifact.taskTags && artifact.taskTags.length > 0) {
    metadata.push(`tags: ${JSON.stringify(artifact.taskTags)}`);
  }
  if (artifact.reminderStatus) metadata.push(`status: ${artifact.reminderStatus}`);
  if (artifact.reminderDueAt) {
    metadata.push(`${artifact.reminderDueState ?? "due"}: ${artifact.reminderDueAt}`);
  }
  return metadata.length > 0 ? ` · ${metadata.join(" · ")}` : "";
}

function formatEvidence(pack: ContinuityPack): string[] {
  return pack.evidence.map((entry) => {
    const prefix = `[${entry.reference.artifactType}:${entry.reference.artifactId}]`;
    if (entry.status === "unavailable") return `  - ${prefix} unavailable`;
    if (pack.policy.nextStep === "hidden" && entry.reference.role === "next-step") return `  - ${prefix}`;
    const artifact = entry.artifact!;
    const isContextualNextStep = pack.policy.nextStep === "contextual"
      && pack.nextStep !== undefined
      && entry.reference.artifactId === pack.nextStep.artifactId
      && entry.reference.artifactType === pack.nextStep.artifactType
      && entry.reference.providerId === pack.nextStep.providerId
      && entry.reference.role === pack.nextStep.role;
    const detail = pack.policy.detail === "standard" && artifact.summary && !isContextualNextStep
      ? ` — ${artifact.summary}`
      : "";
    return `  - ${prefix} ${artifact.title}${detail}${formatArtifactMetadata(artifact)}`;
  });
}

export function formatPack(pack: ContinuityPack, deliveryId: string, runId?: string): string {
  const lines = [`${pack.thread.title} [${pack.thread.kind}]`, "Connected context:", ...formatEvidence(pack)];
  if (pack.previousOutcome) lines.push(`Previous pack: ${pack.previousOutcome}`);
  if (pack.policy.nextStep === "hidden") {
    lines.push("Next step: hidden after your previous feedback.");
  } else if (pack.nextStep) {
    if (pack.policy.nextStep === "contextual") {
      lines.push(pack.nextStep.summary
        ? `Next-action notes: ${pack.nextStep.summary} [${pack.nextStep.artifactId}]`
        : `Next step needs detail: muse tasks edit ${pack.nextStep.artifactId} --notes "<first concrete action>" --local`);
    } else {
      lines.push(`Next step: ${pack.nextStep.title} [${pack.nextStep.artifactId}]`);
    }
  } else {
    // A next-step is ONLY populated from a task linked with `--role next-step`
    // (continuity-pack.ts). Saying "no open local task is linked" when a task IS
    // linked as context is misleading — the fix seen while dogfooding is to name
    // the actual gap and the exact action that closes it.
    const contextTask = pack.evidence.find(
      (entry) => entry.status === "available" && entry.reference.artifactType === "task" && entry.reference.role === "context"
    );
    lines.push(
      contextTask
        ? `Next step: none set — task ${contextTask.reference.artifactId} is linked as context; re-link it with \`--role next-step\` to make it the next action.`
        : "Next step: none set — link an open task with `--role next-step`."
    );
  }
  lines.push(`Delivery: ${deliveryId}`);
  if (runId) lines.push(`Run: ${runId}`);
  lines.push(`Record feedback: muse thread outcome ${deliveryId} <used|adjusted|ignored|rejected>`);
  return `${lines.join("\n")}\n`;
}

async function selectThreadInteractively(threads: readonly PersonalThread[]): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new AttunementStoreError("thread id is required outside an interactive terminal");
  }
  if (threads.length === 0) throw new AttunementStoreError("no personal threads yet; start one with `muse thread start <title> --kind <life|work>`");
  const chosen = await select({
    message: "Choose a personal thread",
    options: threads.map((thread) => ({ label: `${thread.title} [${thread.kind}]`, value: thread.id }))
  });
  if (isCancel(chosen)) throw new AttunementStoreError("thread selection cancelled");
  return chosen;
}

async function resolveContinueThreadId(threadId: string | undefined): Promise<string> {
  if (threadId?.trim()) return threadId.trim();
  return selectThreadInteractively((await readAttunementState(attunementFile())).threads);
}

async function runContinue(
  io: ProgramIO,
  threadId: string | undefined,
  resolveExactArtifact: ExactArtifactResolver,
  now: () => number
): Promise<void> {
  const file = attunementFile();
  const chosenId = await resolveContinueThreadId(threadId);
  const { delivery, pack } = await openProductionAuthorizedContinuityPack(file, chosenId, resolveExactArtifact, { now });
  io.stdout(formatPack(pack, delivery.id, delivery.runId));
}

async function commandAction(command: Command, io: ProgramIO, label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (cause) {
    io.stderr(`${errorMessage(cause)}\n`);
    command.error(`${label} failed`, { exitCode: 1 });
  }
}

export function registerAttunementCommands(program: Command, io: ProgramIO, deps: AttunementCommandDeps = {}): void {
  const mcpResourceCaller = deps.mcpResourceCaller ?? defaultMcpResourceCaller();
  const now = deps.now ?? Date.now;
  const validateArtifact = createArtifactValidator(mcpResourceCaller);
  const resolveExactArtifact = createResolveExactArtifact(mcpResourceCaller);
  const thread = program.command("thread").description("Keep an explicitly chosen life or work thread ready to resume");

  thread
    .command("start <title...>")
    .description("Start a life or work thread — kind is always explicit")
    .requiredOption("--kind <life|work>", "thread kind (required; no default)")
    .action(async (titleParts: string[], options: { readonly kind: string }, command: Command) => {
      await commandAction(command, io, "thread start", async () => {
        const kind = options.kind.trim().toLowerCase();
        assertChoice(kind, THREAD_KINDS, "--kind");
        const created = await createPersonalThread(attunementFile(), { kind: kind as PersonalThread["kind"], title: titleParts.join(" ") });
        io.stdout(`Started ${created.kind} thread ${created.id}: ${created.title}\n`);
      });
    });

  thread
    .command("list")
    .description("List your explicitly chosen personal threads")
    .option("--json", "Print structured thread data")
    .action(async (options: { readonly json?: boolean }, command: Command) => {
      await commandAction(command, io, "thread list", async () => {
        const threads = (await readAttunementState(attunementFile())).threads;
        if (options.json) {
          io.stdout(`${JSON.stringify({ threads }, null, 2)}\n`);
          return;
        }
        if (threads.length === 0) {
          io.stdout("No personal threads yet. Start one with `muse thread start <title> --kind <life|work>`.\n");
          return;
        }
        for (const item of threads) io.stdout(`${item.id}  [${item.kind}]  ${item.title}\n`);
      });
    });

  thread
    .command("link <thread-id> <artifact-type> <artifact-id>")
    .description("Explicitly link one exact local task/note/reminder, or an external MCP resource (<server>/<resource-id>), to a thread")
    .requiredOption("--role <context|next-step>", "how this source is used (a resource is context-only)")
    .addHelpText("after", `
Examples:
  $ muse thread link <thread-id> task <task-id> --role next-step
  $ muse thread link <thread-id> note ideas.md --role context
  $ muse thread link <thread-id> resource github/facebook/react/issues/123 --role context`)
    .action(async (threadId: string, artifactType: string, artifactId: string, options: { readonly role: string }, command: Command) => {
      await commandAction(command, io, "thread link", async () => {
        const type = artifactType.trim().toLowerCase();
        const role = options.role.trim().toLowerCase();
        assertChoice(type, ARTIFACT_TYPES, "artifact type");
        assertChoice(role, ARTIFACT_ROLES, "--role");
        const input = type === "resource"
          ? buildResourceLinkInput(artifactId, role as ArtifactLink["role"], threadId.trim())
          : {
              artifactId,
              artifactType: type as ArtifactLink["artifactType"],
              role: role as ArtifactLink["role"],
              threadId: threadId.trim()
            };
        const result = await linkArtifact(attunementFile(), input, { validateArtifact });
        io.stdout(`${result.created ? "Linked" : "Already linked"} ${result.link.providerId}:${result.link.artifactType}:${result.link.artifactId} as ${result.link.role}\n`);
      });
    });

  thread
    .command("unlink <thread-id> <artifact-type> <artifact-id>")
    .description("Remove one exact local source link from a thread")
    .action(async (threadId: string, artifactType: string, artifactId: string, _options: unknown, command: Command) => {
      await commandAction(command, io, "thread unlink", async () => {
        const type = artifactType.trim().toLowerCase();
        assertChoice(type, ARTIFACT_TYPES, "artifact type");
        const removed = await unlinkArtifact(attunementFile(), { artifactId: artifactId.trim(), artifactType: type as ArtifactLink["artifactType"], threadId: threadId.trim() });
        if (!removed) throw new AttunementStoreError(`no ${type} link '${artifactId}' on thread '${threadId}'`);
        io.stdout(`Unlinked ${type}:${artifactId}\n`);
      });
    });

  thread
    .command("delete <thread-id>")
    .description("Delete one personal thread and its continuity deliveries and policy receipts")
    .action(async (threadId: string, _options: unknown, command: Command) => {
      await commandAction(command, io, "thread delete", async () => {
        const deleted = await deletePersonalThread(attunementFile(), threadId.trim());
        io.stdout(`Deleted ${deleted.thread.kind} thread ${deleted.thread.id} (${String(deleted.deletedDeliveries)} deliveries, ${String(deleted.deletedResetReceipts)} reset receipts)\n`);
      });
    });

  const registerContinue = (target: Command, name: string): void => {
    target
      .command(`${name} [thread-id]`)
      .description("Prepare a grounded continuity pack from this thread's explicit local links")
      .action(async (threadId: string | undefined, _options: unknown, command: Command) => {
        await commandAction(command, io, "continue", () => runContinue(io, threadId, resolveExactArtifact, now));
      });
  };
  registerContinue(thread, "continue");
  registerContinue(program, "continue");

  thread
    .command("stats")
    .description("Show continuity outcome counts (used/adjusted/ignored/rejected) and the first-20-packs kill-criterion check")
    .option("--json", "Print structured stats")
    .action(async (options: { readonly json?: boolean }, command: Command) => {
      await commandAction(command, io, "thread stats", async () => {
        const stats = computeContinuityStats(await readAttunementState(attunementFile()));
        io.stdout(options.json ? `${JSON.stringify(stats, null, 2)}\n` : formatContinuityStats(stats));
      });
    });

  thread
    .command("interactions")
    .description("Inspect factual Continuity task interactions without inferring usefulness")
    .option("--json", "Print the canonical interaction report and digest")
    .action(async (options: { readonly json?: boolean }, command: Command) => {
      await commandAction(command, io, "thread interactions", async () => {
        const report = await buildContinuityInteractionReport(
          await readAttunementState(attunementFile()),
          createLocalContinuityTaskInteractionSourceResolver(tasksFile())
        );
        if (options.json) {
          io.stdout(`${JSON.stringify(report, null, 2)}\n`);
          return;
        }
        const formatSlice = (label: string, slice: typeof report.digest.overall): string => {
          const latency = slice.completionLatencyMs.sampleSize === 0
            ? "latency n=0"
            : `latency n=${slice.completionLatencyMs.sampleSize.toString()} median=${slice.completionLatencyMs.medianMs!.toString()}ms p95=${slice.completionLatencyMs.p95Ms!.toString()}ms`;
          return `${label}: ${slice.totalDeliveries.toString()} ${slice.totalDeliveries === 1 ? "delivery" : "deliveries"}; exact=${slice.states.exact.count.toString()} none=${slice.states.none.count.toString()} unavailable=${slice.states.unavailable.count.toString()}; ${latency}`;
        };
        io.stdout("Production-authorized interaction coverage (organic-authorized pairs; not verified natural behavior):\n");
        io.stdout(`${formatSlice("Interaction digest", report.digest.overall)}\n`);
        io.stdout(`  ${formatSlice("life", report.digest.byThreadKind.life)}\n`);
        io.stdout(`  ${formatSlice("work", report.digest.byThreadKind.work)}\n`);
        io.stdout(`Interaction audit: ${report.audit.status}\n`);
        for (const kind of ["life", "work"] as const) {
          const coverage = report.audit.byThreadKind[kind];
          io.stdout(`  ${kind}: exact=${coverage.exactInteractions.toString()}/${coverage.exactInteractionsTarget.toString()} opened UTC dates=${coverage.distinctUtcOpenedDates.toString()}/${coverage.distinctUtcOpenedDatesTarget.toString()}\n`);
        }
        io.stdout("  Numeric coverage does not certify natural timing, usefulness, or permission.\n");
        const technical = report.technicalEvidence.overall;
        io.stdout("All recorded technical interaction evidence (excluded from numeric coverage unless both sides are organic-authorized):\n");
        io.stdout(`  deliveries organic=${technical.deliveries.organic.toString()} controlled=${technical.deliveries.controlled.toString()} unclassified=${technical.deliveries.unclassified.toString()}; receipts organic=${technical.receipts.organic.toString()} controlled=${technical.receipts.controlled.toString()} unclassified=${technical.receipts.unclassified.toString()}.\n`);
        if (report.interactions.length === 0) {
          io.stdout("No Continuity deliveries have interaction evidence yet.\n");
          return;
        }
        for (const item of report.interactions) {
          io.stdout(`${item.deliveryId}  interaction=${item.interaction.state}  outcome=${item.explicitOutcome ?? "unscored"}\n`);
        }
      });
    });

  thread
    .command("review")
    .description("Review the next unscored first-20 Continuity Pack with exact evidence and outcome commands")
    .option("--json", "Print the deterministic first-20 review queue")
    .action(async (options: { readonly json?: boolean }, command: Command) => {
      await commandAction(command, io, "thread review", async () => {
        const state = await readAttunementState(attunementFile());
        const queue = await prepareCliContinuityReview(state, resolveExactArtifact);
        if (options.json) {
          io.stdout(`${JSON.stringify(queue, null, 2)}\n`);
          return;
        }
        io.stdout(formatContinuityReviewQueue(queue));
        io.stdout(await formatThreadReview(state, resolveExactArtifact, now));
      });
    });

  thread
    .command("inspect <thread-id>")
    .description("Inspect a thread's links, deliveries, policy, and reset receipts")
    .option("--json", "Print structured inspection data")
    .action(async (threadId: string, options: { readonly json?: boolean }, command: Command) => {
      await commandAction(command, io, "thread inspect", async () => {
        const inspection = inspectThread(await readAttunementState(attunementFile()), threadId.trim());
        if (options.json) {
          io.stdout(`${JSON.stringify(inspection, null, 2)}\n`);
          return;
        }
        io.stdout(`${inspection.thread.title} [${inspection.thread.kind}]\n`);
        io.stdout(`Policy: ${inspection.thread.policy.detail} / ${inspection.thread.policy.nextStep} / ${inspection.thread.policy.suppression} (v${inspection.thread.policy.version.toString()})\n`);
        io.stdout(`Links: ${inspection.thread.links.length.toString()}  Deliveries: ${inspection.deliveries.length.toString()}  Resets: ${inspection.resetReceipts.length.toString()}\n`);
      });
    });

  thread
    .command("outcome <delivery-id> <outcome>")
    .description("Record how a continuity pack helped: used, adjusted, ignored, or rejected")
    .action(async (deliveryId: string, outcome: string, _options: unknown, command: Command) => {
      await commandAction(command, io, "thread outcome", async () => {
        const canonicalOutcome = outcome.trim().toLowerCase();
        assertChoice(canonicalOutcome, OUTCOMES, "outcome");
        const recorded = await recordProductionAuthorizedContinuityOutcome(
          attunementFile(),
          deliveryId.trim(),
          canonicalOutcome as (typeof OUTCOMES)[number]
        );
        io.stdout(`${recorded.applied ? "Recorded" : "Already recorded"} ${canonicalOutcome} for ${deliveryId}; policy v${recorded.policy.version.toString()}\n`);
      });
    });

  thread
    .command("reset <thread-id>")
    .description("Reset this thread's display policy without deleting its links or feedback history")
    .action(async (threadId: string, _options: unknown, command: Command) => {
      await commandAction(command, io, "thread reset", async () => {
        const reset = await resetThreadPolicy(attunementFile(), threadId.trim());
        if (reset.alreadyBaseline) {
          io.stdout(`Thread ${threadId} already uses the baseline policy.\n`);
          return;
        }
        io.stdout(`Reset ${threadId} to baseline policy (receipt ${reset.receipt!.id}). Undo with: muse thread undo-reset ${threadId} ${reset.receipt!.id}\n`);
      });
    });

  thread
    .command("undo-reset <thread-id> <reset-id>")
    .description("Undo the latest unchanged policy reset using its receipt")
    .action(async (threadId: string, resetId: string, _options: unknown, command: Command) => {
      await commandAction(command, io, "thread undo-reset", async () => {
        const undone = await undoThreadReset(attunementFile(), threadId.trim(), resetId.trim());
        io.stdout(`${undone.applied ? "Undid" : "Already undid"} reset ${resetId}; policy v${undone.thread.policy.version.toString()}\n`);
      });
    });
}
