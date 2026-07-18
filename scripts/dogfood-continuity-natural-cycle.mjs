#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const CLI_INDEX = fileURLToPath(new URL("../apps/cli/dist/index.js", import.meta.url));
const RESTRICTED_ARTIFACT_KEYS = new Set([
  "artifactId",
  "content",
  "deliveryId",
  "interaction",
  "interactions",
  "linkedAt",
  "openedAt",
  "path",
  "receipt",
  "runId",
  "sha256",
  "taskId",
  "threadId",
  "timestamp",
  "title"
]);

export class ContinuityNaturalCollectionCycleError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContinuityNaturalCollectionCycleError";
  }
}

function isNodeErrorCode(cause, code) {
  return cause && typeof cause === "object" && "code" in cause && cause.code === code;
}

async function snapshotFile(file) {
  try {
    const bytes = await readFile(file);
    return {
      bytes,
      exists: true,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return { bytes: undefined, exists: false, sha256: null };
    throw cause;
  }
}

async function snapshotFiles(files) {
  const [attunement, outbox, tasks] = await Promise.all([
    snapshotFile(files.attunementFile),
    snapshotFile(files.outboxFile),
    snapshotFile(files.tasksFile)
  ]);
  return { attunement, outbox, tasks };
}

function sameFile(left, right) {
  return left.exists === right.exists && left.sha256 === right.sha256;
}

function exactCandidate(state, tasks) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const candidates = state.threads.flatMap((thread) => thread.kind !== "work" ? [] : thread.links.flatMap((link) => {
    const task = tasksById.get(link.artifactId);
    return link.artifactType === "task"
      && link.linkedBy === "user"
      && link.providerId === "local"
      && link.role === "next-step"
      && task?.status === "open"
      ? [{ link, task, thread }]
      : [];
  }));
  if (candidates.length !== 1) {
    throw new ContinuityNaturalCollectionCycleError(`expected exactly one eligible user-linked open work next-step; found ${candidates.length.toString()}`);
  }
  const candidate = candidates[0];
  const receiptDeliveries = new Set(state.interactionReceipts.map((receipt) => receipt.deliveryId));
  const alreadyCollecting = state.deliveries.some((delivery) => {
    const anchor = delivery.interactionAnchor;
    return delivery.threadId === candidate.thread.id
      && !receiptDeliveries.has(delivery.id)
      && anchor?.artifactId === candidate.task.id
      && anchor.linkedAt === candidate.link.linkedAt
      && anchor.providerId === "local"
      && anchor.role === "next-step";
  });
  if (alreadyCollecting) {
    throw new ContinuityNaturalCollectionCycleError("a receipt-incomplete collection delivery already exists for the eligible next-step");
  }
  return candidate;
}

function parseRaw(snapshot, label) {
  if (!snapshot.exists || !snapshot.bytes) throw new ContinuityNaturalCollectionCycleError(`${label} source is missing`);
  try {
    return JSON.parse(snapshot.bytes.toString("utf8"));
  } catch {
    throw new ContinuityNaturalCollectionCycleError(`${label} source is not valid JSON`);
  }
}

function assertCanonicalRawAttunement(value) {
  const base = [
    "deliveries", "nextPolicyVersion", "resetReceipts", "schemaVersion",
    "threads", "undoResetReceipts"
  ];
  const expected = value?.schemaVersion === 1
    ? base
    : value?.schemaVersion === 2
      ? [...base, "interactionReceipts"]
      : [];
  if (expected.length === 0 || !isDeepStrictEqual(Object.keys(value).sort(), expected.sort())) {
    throw new ContinuityNaturalCollectionCycleError("unexpected persisted attunement field; no command was run");
  }
}

function countRestrictedStateKeys(value) {
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + countRestrictedStateKeys(entry), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value).reduce((sum, [key, entry]) =>
    sum + (/^(?:permission|grant|autonomy)/iu.test(key) ? 1 : 0) + countRestrictedStateKeys(entry), 0);
}

function assertArtifactHasNoRestrictedEvidence(value) {
  if (Array.isArray(value)) {
    for (const entry of value) assertArtifactHasNoRestrictedEvidence(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (RESTRICTED_ARTIFACT_KEYS.has(key)) {
      throw new ContinuityNaturalCollectionCycleError(`aggregate artifact contains restricted evidence key '${key}'`);
    }
    assertArtifactHasNoRestrictedEvidence(entry);
  }
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) {
    throw new ContinuityNaturalCollectionCycleError(`unexpected aggregate artifact field in ${label}`);
  }
}

export function validateContinuityNaturalCollectionArtifact(artifact) {
  assertExactKeys(artifact, [
    "after", "before", "classification", "commandAttempts", "commandSucceeded",
    "delta", "invariants", "naturalLongitudinalEvidence", "permissionExpansion",
    "schema", "syntheticDataUsed"
  ], "root");
  assertExactKeys(artifact.before, ["deliveries", "exactInteractions", "noneInteractions"], "before");
  assertExactKeys(artifact.after, ["deliveries", "exactInteractions", "noneInteractions"], "after");
  assertExactKeys(artifact.delta, ["deliveries"], "delta");
  assertExactKeys(artifact.invariants, [
    "canonicalStructuralDiff", "freshPreflight", "newDeliveryIsOpenNone",
    "noPermissionExpansion", "outboxBytesUnchanged", "outboxExistenceUnchanged",
    "tasksBytesUnchanged", "uniqueUserLinkedCandidate"
  ], "invariants");
  if (artifact?.schema !== "muse.continuity-natural-collection-start/v1"
    || artifact.classification !== "actual-local-collection-start") {
    throw new ContinuityNaturalCollectionCycleError("unexpected natural collection artifact schema");
  }
  if (artifact.syntheticDataUsed !== false
    || artifact.naturalLongitudinalEvidence !== false
    || artifact.permissionExpansion !== false
    || artifact.commandAttempts !== 1
    || artifact.commandSucceeded !== true
    || artifact.delta?.deliveries !== 1) {
    throw new ContinuityNaturalCollectionCycleError("natural collection artifact overclaims its evidence or command result");
  }
  const counts = [
    artifact.before.deliveries, artifact.before.exactInteractions, artifact.before.noneInteractions,
    artifact.after.deliveries, artifact.after.exactInteractions, artifact.after.noneInteractions
  ];
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)
    || artifact.after.deliveries !== artifact.before.deliveries + 1
    || artifact.after.exactInteractions !== artifact.before.exactInteractions
    || artifact.after.noneInteractions !== artifact.before.noneInteractions + 1) {
    throw new ContinuityNaturalCollectionCycleError("aggregate counts do not describe one none collection start");
  }
  if (!artifact.invariants || Object.values(artifact.invariants).some((value) => value !== true)) {
    throw new ContinuityNaturalCollectionCycleError("natural collection artifact has a failed invariant");
  }
  assertArtifactHasNoRestrictedEvidence(artifact);
  return artifact;
}

function exactOpenFingerprint(task) {
  return createHash("sha256").update(JSON.stringify({
    artifactId: task.id,
    status: "open",
    updatedAt: task.createdAt
  })).digest("hex");
}

function assertCanonicalTransition({ before, candidate, post, postRaw, preRaw, report }) {
  if (!isDeepStrictEqual(post.threads, before.threads)
    || post.nextPolicyVersion !== before.nextPolicyVersion
    || !isDeepStrictEqual(post.resetReceipts, before.resetReceipts)
    || !isDeepStrictEqual(post.undoResetReceipts, before.undoResetReceipts)
    || !isDeepStrictEqual(post.interactionReceipts, before.interactionReceipts)) {
    throw new ContinuityNaturalCollectionCycleError("natural collection changed canonical state outside deliveries");
  }
  const beforeById = new Map(before.deliveries.map((delivery) => [delivery.id, delivery]));
  const postExisting = post.deliveries.filter((delivery) => beforeById.has(delivery.id));
  if (postExisting.length !== before.deliveries.length
    || postExisting.some((delivery) => !isDeepStrictEqual(delivery, beforeById.get(delivery.id)))) {
    throw new ContinuityNaturalCollectionCycleError("natural collection changed an existing delivery");
  }
  const added = post.deliveries.filter((delivery) => !beforeById.has(delivery.id));
  if (added.length !== 1 || post.deliveries.length !== before.deliveries.length + 1) {
    throw new ContinuityNaturalCollectionCycleError("natural collection did not add exactly one delivery");
  }
  const delivery = added[0];
  const anchor = delivery.interactionAnchor;
  const runIds = post.deliveries.flatMap((entry) => typeof entry.runId === "string" ? [entry.runId] : []);
  if (delivery.threadId !== candidate.thread.id
    || delivery.outcome !== undefined
    || typeof delivery.runId !== "string"
    || delivery.runId.trim().length === 0
    || new Set(runIds).size !== runIds.length
    || !anchor
    || anchor.artifactId !== candidate.task.id
    || anchor.linkedAt !== candidate.link.linkedAt
    || anchor.observedAt !== delivery.openedAt
    || anchor.observedStatus !== "open"
    || anchor.openStateFingerprint !== exactOpenFingerprint(candidate.task)
    || anchor.providerId !== "local"
    || anchor.role !== "next-step") {
    throw new ContinuityNaturalCollectionCycleError("new delivery is not bound to the exact open user-linked task");
  }
  const projected = report.interactions.filter((item) => item.deliveryId === delivery.id);
  if (projected.length !== 1
    || projected[0].threadKind !== "work"
    || projected[0].interaction.state !== "none"
    || projected[0].interaction.receipt !== undefined
    || projected[0].explicitOutcome !== undefined) {
    throw new ContinuityNaturalCollectionCycleError("new delivery is not the canonical unscored none projection");
  }
  if ((preRaw.schemaVersion !== 1 && preRaw.schemaVersion !== 2)
    || postRaw.schemaVersion !== 2
    || !Array.isArray(postRaw.interactionReceipts)) {
    throw new ContinuityNaturalCollectionCycleError("natural collection did not use the canonical v2 persisted format");
  }
  assertCanonicalRawAttunement(postRaw);
  return delivery;
}

export function invokePublicContinueOnce({ env, spawn = spawnSync, threadId }) {
  const result = spawn(process.execPath, [CLI_INDEX, "thread", "continue", threadId], {
    encoding: "utf8",
    env,
    timeout: 30_000
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new ContinuityNaturalCollectionCycleError("public continue command did not finish successfully");
  }
}

async function loadDefaultRuntime(env) {
  const [autoconfigure, attunement, stores] = await Promise.all([
    import(new URL("../packages/autoconfigure/dist/index.js", import.meta.url).href),
    import(new URL("../packages/attunement/dist/index.js", import.meta.url).href),
    import(new URL("../packages/stores/dist/index.js", import.meta.url).href)
  ]);
  const attunementFile = autoconfigure.resolveAttunementFile(env);
  const tasksFile = autoconfigure.resolveTasksFile(env);
  return {
    files: {
      attunementFile,
      outboxFile: attunement.resolveContinuityInteractionOutboxFile(attunementFile),
      tasksFile
    },
    runtime: {
      buildReport: (state) => attunement.buildContinuityInteractionReport(
        state,
        attunement.createLocalContinuityTaskInteractionSourceResolver(tasksFile)
      ),
      invokeContinue: async (threadId) => invokePublicContinueOnce({ env, threadId }),
      readAttunementState: () => attunement.readAttunementState(attunementFile),
      readTasks: () => stores.readTasks(tasksFile)
    }
  };
}

export async function runContinuityNaturalCollectionCycle(options = {}) {
  const loaded = options.runtime && options.files
    ? { files: options.files, runtime: options.runtime }
    : await loadDefaultRuntime(options.env ?? process.env);
  const { files, runtime } = loaded;
  const initialFiles = await snapshotFiles(files);
  const preRaw = parseRaw(initialFiles.attunement, "attunement");
  assertCanonicalRawAttunement(preRaw);
  const [before, beforeTasks] = await Promise.all([
    runtime.readAttunementState(),
    runtime.readTasks()
  ]);
  const candidate = exactCandidate(before, beforeTasks);
  const beforeReport = await runtime.buildReport(before);

  const freshFiles = await snapshotFiles(files);
  if (!sameFile(initialFiles.attunement, freshFiles.attunement)
    || !sameFile(initialFiles.tasks, freshFiles.tasks)
    || !sameFile(initialFiles.outbox, freshFiles.outbox)) {
    throw new ContinuityNaturalCollectionCycleError("local sources drifted during the preflight; no command was run");
  }
  const [freshState, freshTasks] = await Promise.all([
    runtime.readAttunementState(),
    runtime.readTasks()
  ]);
  const freshCandidate = exactCandidate(freshState, freshTasks);
  if (!isDeepStrictEqual(freshState, before)
    || !isDeepStrictEqual(freshTasks, beforeTasks)
    || !isDeepStrictEqual(freshCandidate, candidate)) {
    throw new ContinuityNaturalCollectionCycleError("eligible collection candidate drifted during the preflight; no command was run");
  }

  let commandError;
  try {
    await runtime.invokeContinue(candidate.thread.id);
  } catch (cause) {
    commandError = cause;
  }

  const postFiles = await snapshotFiles(files);
  const [post, postTasks] = await Promise.all([
    runtime.readAttunementState(),
    runtime.readTasks()
  ]);
  const report = await runtime.buildReport(post);
  if (commandError) {
    const applied = post.deliveries.length === before.deliveries.length + 1;
    throw new ContinuityNaturalCollectionCycleError(`public continue command failed; post-state applied=${String(applied)}; no retry was attempted`);
  }
  if (!sameFile(initialFiles.tasks, postFiles.tasks) || !isDeepStrictEqual(postTasks, beforeTasks)) {
    throw new ContinuityNaturalCollectionCycleError("natural collection changed the tasks source");
  }
  if (!sameFile(initialFiles.outbox, postFiles.outbox)) {
    throw new ContinuityNaturalCollectionCycleError("natural collection changed the interaction outbox");
  }
  if (postTasks.find((task) => task.id === candidate.task.id)?.status !== "open") {
    throw new ContinuityNaturalCollectionCycleError("natural collection completed or replaced the candidate task");
  }
  const postRaw = parseRaw(postFiles.attunement, "attunement");
  assertCanonicalTransition({ before, candidate, post, postRaw, preRaw, report });
  if (countRestrictedStateKeys(postRaw) !== countRestrictedStateKeys(preRaw)) {
    throw new ContinuityNaturalCollectionCycleError("natural collection changed permission, grant, or autonomy keys");
  }

  return validateContinuityNaturalCollectionArtifact({
    after: {
      deliveries: report.digest.overall.totalDeliveries,
      exactInteractions: report.digest.overall.states.exact.count,
      noneInteractions: report.digest.overall.states.none.count
    },
    before: {
      deliveries: beforeReport.digest.overall.totalDeliveries,
      exactInteractions: beforeReport.digest.overall.states.exact.count,
      noneInteractions: beforeReport.digest.overall.states.none.count
    },
    classification: "actual-local-collection-start",
    commandAttempts: 1,
    commandSucceeded: true,
    delta: { deliveries: post.deliveries.length - before.deliveries.length },
    invariants: {
      canonicalStructuralDiff: true,
      freshPreflight: true,
      newDeliveryIsOpenNone: true,
      noPermissionExpansion: true,
      outboxBytesUnchanged: true,
      outboxExistenceUnchanged: true,
      tasksBytesUnchanged: true,
      uniqueUserLinkedCandidate: true
    },
    naturalLongitudinalEvidence: false,
    permissionExpansion: false,
    schema: "muse.continuity-natural-collection-start/v1",
    syntheticDataUsed: false
  });
}

if (process.argv.includes("--cycle-run")) {
  try {
    process.stdout.write(`${JSON.stringify(await runContinuityNaturalCollectionCycle(), null, 2)}\n`);
  } catch (cause) {
    process.stderr.write(`dogfood:continuity-natural-cycle FAIL — ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
