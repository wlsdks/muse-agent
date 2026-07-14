/**
 * Personal Continuity CLI — deliberately local and deterministic. The user
 * chooses a life/work thread and explicitly links sources; this command never
 * asks a model to infer affiliation, timing, permission, or an external action.
 */

import { isCancel, select } from "@clack/prompts";
import {
  AttunementStoreError,
  buildContinuityPack,
  createPersonalThread,
  inspectThread,
  linkArtifact,
  mcpProviderId,
  openContinuityDelivery,
  readAttunementState,
  recordContinuityOutcome,
  resetThreadPolicy,
  undoThreadReset,
  unlinkArtifact,
  type ArtifactLink,
  type ArtifactLinkValidator,
  type AttunementState,
  type ContinuityOutcome,
  type ContinuityPack,
  type ExactArtifactResolver,
  type PersonalThread
} from "@muse/attunement";
import { isNodeErrorCode, NODE_ERROR_CODES } from "@muse/shared";
import { resolveAttunementFile, resolveNotesDir, resolveTasksFile, type MuseEnvironment } from "@muse/autoconfigure";
import { readTaskById, readTasks } from "@muse/stores";
import { promises as fs } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { Command } from "commander";

import {
  resolveMcpResourceArtifact,
  serverFromProviderId,
  validateMcpResource,
  type McpToolCaller
} from "./attunement-mcp-resource.js";
import type { ProgramIO } from "./program.js";

const THREAD_KINDS = ["life", "work"] as const;
type ThreadKind = (typeof THREAD_KINDS)[number];
const THREAD_KIND_SET = new Set<string>(THREAD_KINDS);
const ARTIFACT_TYPES = ["task", "note", "resource"] as const;
type ArtifactType = (typeof ARTIFACT_TYPES)[number];
const ARTIFACT_TYPE_SET = new Set<string>(ARTIFACT_TYPES);
const ARTIFACT_ROLES = ["context", "next-step"] as const;
type ArtifactRole = (typeof ARTIFACT_ROLES)[number];
const ARTIFACT_ROLE_SET = new Set<string>(ARTIFACT_ROLES);
const OUTCOMES = ["used", "adjusted", "ignored", "rejected"] as const;
type Outcome = (typeof OUTCOMES)[number];
const OUTCOME_SET = new Set<string>(OUTCOMES);

export interface AttunementCommandDeps {
  /**
   * Calls a READ tool on a connected MCP server so a `resource` link can be
   * validated / resolved. Defaults to a lazily-built live McpManager; tests
   * inject a contract-faithful fake. Absent runtime ⇒ resource linking fails
   * closed with a "connect the MCP server first" message.
   */
  readonly mcpResourceCaller?: McpToolCaller;
}

function environment(): MuseEnvironment {
  return process.env;
}

function attunementFile(): string {
  return resolveAttunementFile(environment());
}

function tasksFile(): string {
  return resolveTasksFile(environment());
}

function notesDir(): string {
  return resolveNotesDir(environment());
}

function assertChoice<T extends string>(value: string, allowed: readonly T[], allowedSet: ReadonlySet<string>, name: string): asserts value is T {
  if (allowedSet.has(value)) {
    return;
  }
  throw new AttunementStoreError(`${name} must be one of: ${allowed.join(", ")}`);
}

function assertNoDotDotPath(value: string): void {
  if (value.split(/[\\/]+/u).some((segment) => segment === "..")) {
    throw new AttunementStoreError("note id must not contain '..'");
  }
}

function containedRelative(root: string, target: string): string | undefined {
  const candidate = relative(root, target);
  if (candidate.length === 0 || candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) return undefined;
  return candidate.split(sep).join("/");
}

interface LocalNote {
  readonly artifactId: string;
  readonly summary?: string;
  readonly title: string;
  readonly updatedAt: string;
}

/**
 * Exact local-note reader with realpath containment on every call. A saved
 * relative id is rechecked at display time, so a later symlink swap cannot
 * turn an approved note link into a read outside the vault.
 */
async function readCanonicalLocalNote(rawId: string): Promise<LocalNote | undefined> {
  const id = rawId.trim();
  if (id.length === 0 || isAbsolute(id)) throw new AttunementStoreError("note id must be a relative vault path");
  assertNoDotDotPath(id);
  let vaultRoot: string;
  let target: string;
  try {
    vaultRoot = await fs.realpath(notesDir());
    target = await fs.realpath(resolve(vaultRoot, id));
  } catch (cause) {
    if (isNodeErrorCode(cause, NODE_ERROR_CODES.ENOENT)) return undefined;
    throw cause;
  }
  const artifactId = containedRelative(vaultRoot, target);
  if (!artifactId) throw new AttunementStoreError("note path escapes the local notes vault");
  const stat = await fs.stat(target);
  if (stat.isDirectory()) throw new AttunementStoreError("note id points to a directory");
  if (stat.size > 1_048_576) throw new AttunementStoreError("note exceeds the 1 MiB local continuity limit");
  const body = await fs.readFile(target, "utf8");
  const summary = body
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^#+\s*/u, ""))
    .find((line) => line.length > 0);
  return {
    artifactId,
    ...(summary ? { summary: summary.slice(0, 240) } : {}),
    title: basename(artifactId),
    updatedAt: stat.mtime.toISOString()
  };
}

async function canonicalTaskId(raw: string): Promise<string> {
  const id = raw.trim();
  if (id.length === 0) throw new AttunementStoreError("task id must not be empty");
  const tasks = await readTasks(tasksFile());
  if (tasks.some((task) => task.id === id)) return id;
  const matches = tasks.filter((task) => task.id.startsWith(id));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new AttunementStoreError(`no local task with id or unique prefix '${id}'`);
  throw new AttunementStoreError(`task id prefix '${id}' is ambiguous; pass the full id`);
}

/**
 * The store refuses unvalidated links. This adapter is the only place that
 * knows the local task/notes providers and the external MCP resource provider,
 * so it returns their exact, canonical identifiers rather than trusting a CLI
 * argument. A `resource` is confirmed to exist on its named, connected MCP
 * server before any link is stored.
 */
function createArtifactValidator(mcpCaller: McpToolCaller | undefined): ArtifactLinkValidator {
  return async ({ artifactId, artifactType, providerId }) => {
    if (artifactType === "resource") {
      const server = serverFromProviderId(providerId);
      const resolved = await validateMcpResource(server, artifactId, mcpCaller);
      return { artifactId: resolved.artifactId, artifactType, providerId: resolved.providerId };
    }
    if (artifactType === "task") {
      return { artifactId: await canonicalTaskId(artifactId), artifactType, providerId: "local" };
    }
    const note = await readCanonicalLocalNote(artifactId);
    if (!note) throw new AttunementStoreError(`no local note with exact id '${artifactId}'`);
    return { artifactId: note.artifactId, artifactType, providerId: "local" };
  };
}

function createResolveExactArtifact(mcpCaller: McpToolCaller | undefined): ExactArtifactResolver {
  return async (link) => {
    if (link.artifactType === "resource") {
      // The resolved title/summary is UNTRUSTED external text; it is displayed
      // as evidence and never elevated to a Muse-authored fact. Any failure ⇒
      // undefined ⇒ `unavailable`, never a fabricated placeholder.
      return resolveMcpResourceArtifact(serverFromProviderId(link.providerId), link.artifactId, link.role, mcpCaller);
    }
    if (link.artifactType === "task") {
      const task = await readTaskById(tasksFile(), link.artifactId);
      if (!task) return undefined;
      return {
        artifactId: task.id,
        artifactType: "task",
        providerId: "local",
        role: link.role,
        ...(task.notes ? { summary: task.notes.slice(0, 240) } : {}),
        taskStatus: task.status,
        title: task.title,
        updatedAt: task.completedAt ?? task.createdAt
      };
    }
    const note = await readCanonicalLocalNote(link.artifactId);
    if (!note) return undefined;
    // The stored canonical ID must remain canonical after re-resolution; a note
    // moved or symlinked to another in-vault path is unavailable rather than
    // silently becoming a different source.
    if (note.artifactId !== link.artifactId) return undefined;
    return {
      artifactId: note.artifactId,
      artifactType: "note",
      providerId: "local",
      role: link.role,
      ...(note.summary ? { summary: note.summary } : {}),
      title: note.title,
      updatedAt: note.updatedAt
    };
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
    return tool.execute(args, { runId: `attunement_resource_${Date.now().toString()}`, userId: "owner" });
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

const KILL_CRITERION_FIRST_PACKS = 20;

export interface ContinuityStats {
  readonly totalDeliveries: number;
  readonly withOutcome: number;
  readonly outcomes: Record<ContinuityOutcome, number>;
  readonly firstPacks: {
    readonly considered: number;
    readonly used: number;
    readonly rejected: number;
  };
  /**
   * This is deliberately a release gate, not an automation switch. Passing
   * the outcome threshold never enables proactive delivery by itself.
   */
  readonly automationGate: {
    readonly reasons: readonly string[];
    readonly status: "hold" | "manual-only";
  };
}

/**
 * Deterministic per-outcome accounting over all deliveries + a "first 20 packs"
 * window — the kill-criterion instrument (used<20% or rejected>30% ⇒ fix pack
 * usefulness before more automation). Reads only persisted deliveries; empty
 * state yields zeros, not a crash.
 */
export function computeContinuityStats(state: AttunementState): ContinuityStats {
  const outcomes: Record<ContinuityOutcome, number> = { adjusted: 0, ignored: 0, rejected: 0, used: 0 };
  let withOutcome = 0;
  for (const delivery of state.deliveries) {
    if (delivery.outcome) {
      outcomes[delivery.outcome.outcome] += 1;
      withOutcome += 1;
    }
  }
  const firstDeliveries = [...state.deliveries]
    .sort((left, right) => left.openedAt.localeCompare(right.openedAt))
    .slice(0, KILL_CRITERION_FIRST_PACKS);
  const used = firstDeliveries.filter((delivery) => delivery.outcome?.outcome === "used").length;
  const rejected = firstDeliveries.filter((delivery) => delivery.outcome?.outcome === "rejected").length;
  const reasons: string[] = [];
  if (firstDeliveries.length < KILL_CRITERION_FIRST_PACKS) {
    reasons.push(`need ${String(KILL_CRITERION_FIRST_PACKS - firstDeliveries.length)} more eligible deliveries before evaluating automation`);
  } else {
    if (used * 100 < 20 * firstDeliveries.length) reasons.push("used rate is below the 20% kill criterion");
    if (rejected * 100 > 30 * firstDeliveries.length) reasons.push("rejection rate exceeds the 30% kill criterion");
  }
  return {
    totalDeliveries: state.deliveries.length,
    withOutcome,
    outcomes,
    firstPacks: { considered: firstDeliveries.length, rejected, used },
    automationGate: reasons.length > 0
      ? { reasons, status: "hold" }
      : {
          reasons: ["outcome threshold passed; proactive delivery remains disabled pending the separate Slice B consent and timing gate"],
          status: "manual-only"
        }
  };
}

export function formatContinuityStats(stats: ContinuityStats): string {
  const { outcomes, firstPacks } = stats;
  const lines = [
    `Continuity outcomes across ${stats.totalDeliveries.toString()} deliveries (${stats.withOutcome.toString()} with feedback):`,
    `  used: ${outcomes.used.toString()}  adjusted: ${outcomes.adjusted.toString()}  ignored: ${outcomes.ignored.toString()}  rejected: ${outcomes.rejected.toString()}`,
    `First ${KILL_CRITERION_FIRST_PACKS.toString()} packs: used ${firstPacks.used.toString()}/${firstPacks.considered.toString()}, rejected ${firstPacks.rejected.toString()}/${firstPacks.considered.toString()} (kill criterion: used<20% or rejected>30%)`,
    `Automation gate: ${stats.automationGate.status} — ${stats.automationGate.reasons.join("; ")}.`
  ];
  return `${lines.join("\n")}\n`;
}

function formatEvidence(pack: ContinuityPack): string[] {
  return pack.evidence.map((entry) => {
    const prefix = `[${entry.reference.artifactType}:${entry.reference.artifactId}]`;
    if (entry.status === "unavailable") return `  - ${prefix} unavailable`;
    if (pack.policy.nextStep === "hidden" && entry.reference.role === "next-step") return `  - ${prefix}`;
    const artifact = entry.artifact!;
    const detail = pack.policy.detail === "standard" && artifact.summary ? ` — ${artifact.summary}` : "";
    return `  - ${prefix} ${artifact.title}${detail}`;
  });
}

export function formatPack(pack: ContinuityPack, deliveryId: string): string {
  const lines = [`${pack.thread.title} [${pack.thread.kind}]`, "Connected context:", ...formatEvidence(pack)];
  if (pack.previousOutcome) lines.push(`Previous pack: ${pack.previousOutcome}`);
  if (pack.policy.nextStep === "hidden") {
    lines.push("Next step: hidden after your previous feedback.");
  } else if (pack.nextStep) {
    const label = pack.policy.nextStep === "contextual" ? "Linked next step" : "Next step";
    lines.push(`${label}: ${pack.nextStep.title} [${pack.nextStep.artifactId}]`);
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

async function runContinue(io: ProgramIO, threadId: string | undefined, resolveExactArtifact: ExactArtifactResolver): Promise<void> {
  const file = attunementFile();
  const chosenId = await resolveContinueThreadId(threadId);
  const state = await readAttunementState(file);
  const pack = await buildContinuityPack(state, chosenId, resolveExactArtifact);
  if (!pack.evidence.some((entry) => entry.status === "available")) {
    throw new AttunementStoreError(
      `thread '${chosenId}' has no currently available linked evidence; no delivery was recorded. Inspect its links with \`muse thread inspect ${chosenId}\` and relink an available local source.`
    );
  }
  const delivery = await openContinuityDelivery(file, {
    evidenceRefs: pack.evidenceRefs,
    expectedPolicyVersion: pack.deliveryPolicyVersion,
    threadId: chosenId
  });
  io.stdout(formatPack(pack, delivery.id));
}

async function commandAction(command: Command, io: ProgramIO, label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (cause) {
    io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    command.error(`${label} failed`, { exitCode: 1 });
  }
}

export function registerAttunementCommands(program: Command, io: ProgramIO, deps: AttunementCommandDeps = {}): void {
  const mcpResourceCaller = deps.mcpResourceCaller ?? defaultMcpResourceCaller();
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
        assertChoice(kind, THREAD_KINDS, THREAD_KIND_SET, "--kind");
        const created = await createPersonalThread(attunementFile(), { kind, title: titleParts.join(" ") });
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
    .description("Explicitly link one exact local task/note, or an external MCP resource (<server>/<resource-id>), to a thread")
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
        assertChoice(type, ARTIFACT_TYPES, ARTIFACT_TYPE_SET, "artifact type");
        assertChoice(role, ARTIFACT_ROLES, ARTIFACT_ROLE_SET, "--role");
        const input = type === "resource"
          ? buildResourceLinkInput(artifactId, role, threadId.trim())
          : {
              artifactId,
              artifactType: type,
              role,
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
        assertChoice(type, ARTIFACT_TYPES, ARTIFACT_TYPE_SET, "artifact type");
        const removed = await unlinkArtifact(attunementFile(), { artifactId: artifactId.trim(), artifactType: type, threadId: threadId.trim() });
        if (!removed) throw new AttunementStoreError(`no ${type} link '${artifactId}' on thread '${threadId}'`);
        io.stdout(`Unlinked ${type}:${artifactId}\n`);
      });
    });

  const registerContinue = (target: Command, name: string): void => {
    target
      .command(`${name} [thread-id]`)
      .description("Prepare a grounded continuity pack from this thread's explicit local links")
      .action(async (threadId: string | undefined, _options: unknown, command: Command) => {
        await commandAction(command, io, "continue", () => runContinue(io, threadId, resolveExactArtifact));
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
        assertChoice(canonicalOutcome, OUTCOMES, OUTCOME_SET, "outcome");
        const recorded = await recordContinuityOutcome(attunementFile(), deliveryId.trim(), canonicalOutcome);
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
