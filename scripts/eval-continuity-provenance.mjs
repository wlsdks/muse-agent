import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { computeContinuityEvaluation } from "../packages/attunement/dist/evaluation.js";
import {
  createOrganicContinuityWriteAuthority,
  resolveContinuityEvidenceClass
} from "../packages/attunement/dist/evidence-provenance.js";
import { buildContinuityInteractionReport } from "../packages/attunement/dist/interaction-evidence.js";
import * as publicSurface from "../packages/attunement/dist/index.js";

const CONTROLLED_DELIVERIES = 10_080;
const FORGED_ATTEMPTS = 1_000;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(repoRoot, ".muse-dev", "evals", "continuity-provenance");
const outputFile = join(outputDir, "result.json");
const museHome = join(homedir(), ".muse");
const realFiles = [
  join(museHome, "attunement.json"),
  join(museHome, "tasks.json"),
  join(museHome, "attunement.interaction-outbox.json")
];

async function hashFile(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch (cause) {
    if (cause && typeof cause === "object" && cause.code === "ENOENT") return "missing";
    throw cause;
  }
}

async function realStateHashes() {
  return Object.fromEntries(await Promise.all(realFiles.map(async (file, index) => [`state-${index + 1}`, await hashFile(file)])));
}

const threads = ["life", "work"].map((kind) => ({
  createdAt: "2026-07-18T00:00:00.000Z",
  id: `thread_${kind}`,
  kind,
  links: [],
  policy: { detail: "standard", nextStep: "direct", suppression: "none", version: 0 },
  title: `${kind} controlled evaluation`
}));
const deliveries = Array.from({ length: CONTROLLED_DELIVERIES }, (_, index) => {
  const kind = index % 2 === 0 ? "life" : "work";
  const openedAt = new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString();
  const artifactId = `task_controlled_${index}`;
  const linkedAt = "2025-12-31T00:00:00.000Z";
  const openStateFingerprint = createHash("sha256").update(`open:${artifactId}`).digest("hex");
  return {
    evidenceClass: "controlled",
    evidenceRefs: [{ artifactId, artifactType: "task", providerId: "local", role: "next-step" }],
    id: `delivery_controlled_${index}`,
    interactionAnchor: {
      artifactId,
      linkedAt,
      observedAt: openedAt,
      observedStatus: "open",
      openStateFingerprint,
      providerId: "local",
      role: "next-step"
    },
    openedAt,
    outcome: {
      evidenceClass: "controlled",
      outcome: index % 4 === 0 ? "used" : index % 4 === 1 ? "adjusted" : index % 4 === 2 ? "ignored" : "rejected",
      policyVersion: index + 1,
      recordedAt: new Date(Date.parse(openedAt) + 500).toISOString()
    },
    policyVersion: 0,
    runId: `run_controlled_${index}`,
    threadId: `thread_${kind}`
  };
});
const interactionReceipts = deliveries.map((delivery, index) => ({
  artifactId: delivery.interactionAnchor.artifactId,
  completedAt: new Date(Date.parse(delivery.openedAt) + 750).toISOString(),
  deliveryId: delivery.id,
  doneStateFingerprint: createHash("sha256").update(`done:${delivery.interactionAnchor.artifactId}`).digest("hex"),
  eventId: `event_controlled_${index}`,
  evidenceClass: "controlled",
  id: `receipt_controlled_${index}`,
  linkedAt: delivery.interactionAnchor.linkedAt,
  openStateFingerprint: delivery.interactionAnchor.openStateFingerprint,
  providerId: "local",
  recordedAt: new Date(Date.parse(delivery.openedAt) + 800).toISOString(),
  role: "next-step",
  runId: delivery.runId,
  threadId: delivery.threadId,
  transition: "open-to-done"
}));
const state = {
  deliveries,
  interactionReceipts,
  nextPolicyVersion: CONTROLLED_DELIVERIES + 1,
  resetReceipts: [],
  schemaVersion: 3,
  threads,
  undoResetReceipts: []
};

const before = await realStateHashes();
const evaluation = computeContinuityEvaluation(state);
const interactions = await buildContinuityInteractionReport(state, async () => undefined);
const genuine = createOrganicContinuityWriteAuthority();
const publicOrganicProducerNames = [
  "createOrganicContinuityWriteAuthority",
  "openProductionAuthorizedContinuityPack",
  "prepareProductionAuthorizedContinuityTaskCompletionInteraction",
  "recordProductionAuthorizedContinuityOutcome"
].filter((name) => name in publicSurface);
const forgedClasses = Array.from({ length: FORGED_ATTEMPTS }, (_, index) => {
  if (index % 3 === 0) return resolveContinuityEvidenceClass({ evidenceAuthority: JSON.parse(JSON.stringify(genuine)), evidenceClass: "organic" });
  if (index % 3 === 1) return resolveContinuityEvidenceClass({ evidenceAuthority: "organic", evidenceClass: "organic" });
  const attemptedPublicMint = publicSurface.createOrganicContinuityWriteAuthority?.();
  return resolveContinuityEvidenceClass({ evidenceAuthority: attemptedPublicMint, evidenceClass: "organic" });
});
const after = await realStateHashes();
const forgedCounts = forgedClasses.reduce((counts, value) => ({ ...counts, [value]: counts[value] + 1 }), {
  controlled: 0,
  organic: 0,
  unclassified: 0
});
const checks = {
  controlledExcludedFromInteractionNumerator: interactions.audit.byThreadKind.life.exactInteractions === 0
    && interactions.audit.byThreadKind.work.exactInteractions === 0,
  controlledExcludedFromReadiness: evaluation.totalDeliveries === 0 && evaluation.withOutcome === 0,
  controlledExactPairsVisibleOnlyInTechnicalDigest: interactions.technicalEvidence.overall.deliveries.controlled === CONTROLLED_DELIVERIES
    && interactions.technicalEvidence.overall.receipts.controlled === CONTROLLED_DELIVERIES
    && interactions.technicalEvidence.overall.states.exact === CONTROLLED_DELIVERIES,
  controlledVisibleInTechnicalDigest: evaluation.technicalEvidence.overall.deliveries.controlled === CONTROLLED_DELIVERIES,
  forgedOrganicRejected: forgedCounts.organic === 0 && forgedCounts.unclassified === FORGED_ATTEMPTS
    && publicOrganicProducerNames.length === 0,
  realStateUnchanged: JSON.stringify(before) === JSON.stringify(after)
};
const result = {
  aggregateOnly: true,
  checks,
  controlled: {
    generatedDeliveries: CONTROLLED_DELIVERIES,
    generatedExactReceipts: interactionReceipts.length,
    interactionNumerator: interactions.audit.byThreadKind.life.exactInteractions + interactions.audit.byThreadKind.work.exactInteractions,
    readinessDeliveries: evaluation.totalDeliveries,
    readinessOutcomes: evaluation.withOutcome,
    technicalDigestSha256: createHash("sha256").update(JSON.stringify({
      evaluation: evaluation.technicalEvidence,
      interactions: interactions.technicalEvidence
    })).digest("hex")
  },
  forged: { attempts: FORGED_ATTEMPTS, classified: forgedCounts, publicMainOrganicProducerNames: publicOrganicProducerNames },
  passed: Object.values(checks).every(Boolean),
  realStateHashes: { after, before },
  schemaVersion: 1
};
await mkdir(outputDir, { recursive: true });
await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
if (!result.passed) process.exitCode = 1;
else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
