#!/usr/bin/env node

import assert from "node:assert/strict";

const DEFAULT_COHORTS = 5_000;
const DEFAULT_MIN_ITEMS = 100_000;
const DEFAULT_SEED = 0x4d555345;
const KINDS = ["life", "work"];
const OUTCOMES = ["used", "adjusted", "ignored", "rejected"];

export function seededRandom(seed = DEFAULT_SEED) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function buildSyntheticInteractionCohort(index, random) {
  const items = [];
  for (const kind of KINDS) {
    const exactCount = Math.floor(random() * 16);
    const dateSpan = exactCount === 0 ? 0 : 1 + Math.floor(random() * 3);
    for (let itemIndex = 0; itemIndex < exactCount; itemIndex += 1) {
      const identity = `${index.toString()}_${kind}_${itemIndex.toString()}`;
      const day = 1 + (itemIndex % dateSpan);
      const openedAt = `2026-07-${day.toString().padStart(2, "0")}T00:00:00.000Z`;
      const completedAt = `2026-07-${day.toString().padStart(2, "0")}T00:00:01.000Z`;
      items.push({
        deliveryId: `delivery_${identity}`,
        ...(random() < 0.7 ? { explicitOutcome: OUTCOMES[Math.floor(random() * OUTCOMES.length)] } : {}),
        interaction: {
          receipt: {
            artifactId: `task_${identity}`,
            completedAt,
            deliveryId: `delivery_${identity}`,
            doneStateFingerprint: "a".repeat(64),
            eventId: `event_${identity}`,
            id: `receipt_${identity}`,
            linkedAt: openedAt,
            openStateFingerprint: "b".repeat(64),
            providerId: "local",
            recordedAt: completedAt,
            role: "next-step",
            runId: `run_${identity}`,
            threadId: `thread_${identity}`,
            transition: "open-to-done"
          },
          state: "exact"
        },
        openedAt,
        runId: `run_${identity}`,
        threadId: `thread_${identity}`,
        threadKind: kind
      });
    }
    for (let itemIndex = 0; itemIndex < 10; itemIndex += 1) {
      const identity = `${index.toString()}_${kind}_non_${itemIndex.toString()}`;
      items.push({
        deliveryId: `delivery_${identity}`,
        ...(random() < 0.7 ? { explicitOutcome: OUTCOMES[Math.floor(random() * OUTCOMES.length)] } : {}),
        interaction: itemIndex % 2 === 0
          ? { state: "none" }
          : { reason: "synthetic unavailable case", state: "unavailable" },
        openedAt: `2026-08-${(itemIndex + 1).toString().padStart(2, "0")}T00:00:00.000Z`,
        threadId: `thread_${identity}`,
        threadKind: kind
      });
    }
  }
  return items;
}

export function independentInteractionAuditOracle(items) {
  const byThreadKind = Object.fromEntries(KINDS.map((kind) => {
    // Production also demands organic provenance on BOTH the delivery and the receipt — the
    // "controlled evidence is never organic" invariant. The oracle drifted behind that
    // tightening and counted controlled interactions as coverage.
    const exact = items.filter((item) =>
      item.threadKind === kind &&
      item.interaction.state === "exact" &&
      item.deliveryEvidenceClass === "organic" &&
      item.interaction.receipt?.evidenceClass === "organic");
    const dates = new Set(exact.map((item) => item.openedAt.slice(0, 10)));
    return [kind, {
      distinctUtcOpenedDates: dates.size,
      distinctUtcOpenedDatesTarget: 2,
      exactInteractions: exact.length,
      exactInteractionsTarget: 10,
      remainingDates: Math.max(0, 2 - dates.size),
      remainingExactInteractions: Math.max(0, 10 - exact.length)
    }];
  }));
  const complete = KINDS.every((kind) =>
    byThreadKind[kind].remainingDates === 0 && byThreadKind[kind].remainingExactInteractions === 0);
  return { byThreadKind, status: complete ? "audit-required" : "collecting" };
}

export function assertProductionMatchesOracle(items, productionAudit) {
  const expected = independentInteractionAuditOracle(items);
  assert.deepEqual(
    { byThreadKind: productionAudit.byThreadKind, status: productionAudit.status },
    expected,
    "production interaction audit diverged from the independent oracle"
  );
}

export function buildOffByOneMutantAudit(items) {
  const oracle = independentInteractionAuditOracle(items);
  const byThreadKind = Object.fromEntries(KINDS.map((kind) => {
    const coverage = oracle.byThreadKind[kind];
    return [kind, {
      ...coverage,
      exactInteractionsTarget: 9,
      remainingExactInteractions: Math.max(0, 9 - coverage.exactInteractions)
    }];
  }));
  const complete = KINDS.every((kind) =>
    byThreadKind[kind].remainingDates === 0 && byThreadKind[kind].remainingExactInteractions === 0);
  return { byThreadKind, reason: "mutant", status: complete ? "audit-required" : "collecting" };
}

export function buildOffByOneBoundaryItems() {
  return KINDS.flatMap((kind) => Array.from({ length: 9 }, (_, index) => {
    const identity = `boundary_${kind}_${index.toString()}`;
    const day = 1 + (index % 2);
    const openedAt = `2026-07-${day.toString().padStart(2, "0")}T00:00:00.000Z`;
    const completedAt = `2026-07-${day.toString().padStart(2, "0")}T00:00:01.000Z`;
    return {
      deliveryId: `delivery_${identity}`,
      interaction: {
        receipt: {
          artifactId: `task_${identity}`,
          completedAt,
          deliveryId: `delivery_${identity}`,
          doneStateFingerprint: "a".repeat(64),
          eventId: `event_${identity}`,
          id: `receipt_${identity}`,
          linkedAt: openedAt,
          openStateFingerprint: "b".repeat(64),
          providerId: "local",
          recordedAt: completedAt,
          role: "next-step",
          runId: `run_${identity}`,
          threadId: `thread_${identity}`,
          transition: "open-to-done"
        },
        state: "exact"
      },
      openedAt,
      runId: `run_${identity}`,
      threadId: `thread_${identity}`,
      threadKind: kind
    };
  }));
}

export function validateSyntheticInteractionAuditArtifact(artifact, { cohorts = DEFAULT_COHORTS, minItems = DEFAULT_MIN_ITEMS } = {}) {
  if (artifact?.schema !== "muse.continuity-interaction-audit-synthetic/v1") throw new Error("unexpected synthetic audit schema");
  if (artifact.classification !== "synthetic-generated" || artifact.naturalLongitudinalEvidence !== false) {
    throw new Error("synthetic data must not be represented as natural longitudinal evidence");
  }
  if (artifact.persistedToAttunement !== false || artifact.permissionExpansion !== false) {
    throw new Error("synthetic evaluation must remain offline and permission-neutral");
  }
  if (artifact.seed !== DEFAULT_SEED || artifact.cohortsProcessed !== cohorts || artifact.interactionItemsProcessed < minItems) {
    throw new Error("synthetic evaluation did not process its fixed seed and required volume");
  }
  if (artifact.oracleMismatches !== 0 || artifact.outcomeContaminationMismatches !== 0 || artifact.counterfactualOffByOneDetected !== true) {
    throw new Error("synthetic evaluator invariants did not hold");
  }
  const classified = artifact.statusCounts?.collecting + artifact.statusCounts?.["audit-required"];
  if (classified !== cohorts) throw new Error("synthetic cohort statuses do not conserve the processed total");
  return artifact;
}

export async function runSyntheticInteractionAuditEvaluation({
  cohorts = DEFAULT_COHORTS,
  minItems = DEFAULT_MIN_ITEMS,
  seed = DEFAULT_SEED
} = {}) {
  if (!Number.isSafeInteger(cohorts) || cohorts < 1) throw new Error("cohorts must be a positive safe integer");
  if (!Number.isSafeInteger(minItems) || minItems < 0) throw new Error("minItems must be a non-negative safe integer");
  const { buildContinuityInteractionAudit } = await import(new URL("../packages/attunement/dist/index.js", import.meta.url).href);
  const random = seededRandom(seed);
  const statusCounts = { "audit-required": 0, collecting: 0 };
  let interactionItemsProcessed = 0;
  let oracleMismatches = 0;
  let outcomeContaminationMismatches = 0;
  for (let index = 0; index < cohorts; index += 1) {
    const items = buildSyntheticInteractionCohort(index, random);
    interactionItemsProcessed += items.length;
    const production = buildContinuityInteractionAudit(items);
    try {
      assertProductionMatchesOracle(items, production);
    } catch {
      oracleMismatches += 1;
    }
    const withoutOutcomes = items.map(({ explicitOutcome: _outcome, ...item }) => item);
    if (JSON.stringify(buildContinuityInteractionAudit(withoutOutcomes)) !== JSON.stringify(production)) {
      outcomeContaminationMismatches += 1;
    }
    statusCounts[production.status] += 1;
  }
  if (interactionItemsProcessed < minItems) {
    throw new Error(`synthetic evaluator processed ${interactionItemsProcessed.toString()} items; expected at least ${minItems.toString()}`);
  }

  const boundary = buildOffByOneBoundaryItems();
  let counterfactualOffByOneDetected = false;
  try {
    assertProductionMatchesOracle(boundary, buildOffByOneMutantAudit(boundary));
  } catch {
    counterfactualOffByOneDetected = true;
  }

  return validateSyntheticInteractionAuditArtifact({
    classification: "synthetic-generated",
    cohortsProcessed: cohorts,
    counterfactualOffByOneDetected,
    interactionItemsProcessed,
    naturalLongitudinalEvidence: false,
    oracleMismatches,
    outcomeContaminationMismatches,
    permissionExpansion: false,
    persistedToAttunement: false,
    schema: "muse.continuity-interaction-audit-synthetic/v1",
    seed,
    statusCounts
  }, { cohorts, minItems });
}

if (process.argv.includes("--eval-run")) {
  try {
    const artifact = await runSyntheticInteractionAuditEvaluation();
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } catch (cause) {
    process.stderr.write(`eval:continuity-interaction-audit FAIL — ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
