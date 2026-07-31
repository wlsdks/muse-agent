import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AttunementStoreError,
  createExperienceLearningPromotionHandle,
  fingerprintContinuityPolicy,
  readAttunementState,
  type AttunementState,
  type ExperienceLearningPolicyAudit
} from "@muse/attunement";
import { describe, expect, it } from "vitest";

import {
  CONTINUITY_PROJECTION_RULE_VERSION,
  CONTINUITY_SOURCE_NAMESPACES,
  ContinuityProjectionError,
  diffContinuityProjections,
  projectContinuityState,
  type ContinuityGraphProjection
} from "./continuity-projection.js";
import { InMemoryAttuneGraphDataStore } from "@attunegraph/core";
import {
  prepareContinuitySourceObservation
} from "./continuity-source-observation.js";

const TASK_FINGERPRINT_OPEN = "a".repeat(64);
const TASK_FINGERPRINT_DONE = "b".repeat(64);
const SOURCE_OBSERVED_AT = "2026-07-29T08:00:00.000Z";

function fixture(): AttunementState {
  const taskLink = {
    artifactId: "task_trip_compare",
    artifactType: "task" as const,
    linkedAt: "2026-07-29T01:00:00.000Z",
    linkedBy: "user" as const,
    providerId: "local" as const,
    role: "next-step" as const,
    threadId: "thread_trip"
  };
  const noteLink = {
    artifactId: "trip/research.md",
    artifactType: "note" as const,
    linkedAt: "2026-07-29T01:01:00.000Z",
    linkedBy: "user" as const,
    providerId: "local" as const,
    role: "context" as const,
    threadId: "thread_trip"
  };
  return {
    deliveries: [
      {
        evidenceClass: "organic",
        evidenceRefs: [
          {
            artifactId: taskLink.artifactId,
            artifactType: taskLink.artifactType,
            providerId: taskLink.providerId,
            role: taskLink.role
          },
          {
            artifactId: noteLink.artifactId,
            artifactType: noteLink.artifactType,
            providerId: noteLink.providerId,
            role: noteLink.role
          }
        ],
        id: "delivery_first",
        openedAt: "2026-07-29T02:00:00.000Z",
        outcome: {
          evidenceClass: "organic",
          outcome: "used",
          ownerNote: "private owner reason",
          policyVersion: 1,
          recordedAt: "2026-07-29T03:00:00.000Z"
        },
        policyVersion: 0,
        runId: "continuity_run_first",
        threadId: "thread_trip"
      },
      {
        evidenceClass: "organic",
        evidenceRefs: [
          {
            artifactId: taskLink.artifactId,
            artifactType: taskLink.artifactType,
            providerId: taskLink.providerId,
            role: taskLink.role
          },
          {
            artifactId: noteLink.artifactId,
            artifactType: noteLink.artifactType,
            providerId: noteLink.providerId,
            role: noteLink.role
          }
        ],
        id: "delivery_interaction",
        interactionAnchor: {
          artifactId: taskLink.artifactId,
          linkedAt: taskLink.linkedAt,
          observedAt: "2026-07-29T04:00:00.000Z",
          observedStatus: "open",
          openStateFingerprint: TASK_FINGERPRINT_OPEN,
          providerId: "local",
          role: "next-step"
        },
        openedAt: "2026-07-29T04:00:00.000Z",
        policyVersion: 1,
        runId: "continuity_run_interaction",
        threadId: "thread_trip"
      }
    ],
    experienceLearningPolicyAudits: [],
    interactionReceipts: [
      {
        artifactId: taskLink.artifactId,
        completedAt: "2026-07-29T05:00:00.000Z",
        deliveryId: "delivery_interaction",
        doneStateFingerprint: TASK_FINGERPRINT_DONE,
        eventId: "continuity_task_completed_trip",
        evidenceClass: "organic",
        id: "continuity_interaction_trip",
        linkedAt: taskLink.linkedAt,
        openStateFingerprint: TASK_FINGERPRINT_OPEN,
        providerId: "local",
        recordedAt: "2026-07-29T05:01:00.000Z",
        role: "next-step",
        runId: "continuity_run_interaction",
        threadId: "thread_trip",
        transition: "open-to-done"
      }
    ],
    nextPolicyVersion: 4,
    resetReceipts: [
      {
        basePolicyVersion: 1,
        beforePolicy: {
          detail: "compact",
          nextStep: "direct",
          suppression: "none",
          version: 1
        },
        id: "reset_trip",
        resetPolicyVersion: 2,
        threadId: "thread_trip"
      }
    ],
    schemaVersion: 12,
    threads: [
      {
        createdAt: "2026-07-29T00:00:00.000Z",
        id: "thread_trip",
        kind: "life",
        links: [taskLink, noteLink],
        policy: {
          detail: "compact",
          nextStep: "direct",
          suppression: "none",
          version: 3
        },
        title: "Private trip title"
      },
      {
        createdAt: "2026-07-29T00:30:00.000Z",
        id: "thread_work",
        kind: "work",
        links: [],
        policy: {
          detail: "standard",
          nextStep: "direct",
          suppression: "none",
          version: 0
        },
        title: "Private work title"
      }
    ],
    undoResetReceipts: [
      {
        id: "undo_trip",
        previousPolicyVersion: 2,
        resetId: "reset_trip",
        restoredPolicy: {
          detail: "compact",
          nextStep: "direct",
          suppression: "none",
          version: 3
        },
        threadId: "thread_trip",
        undoneAt: "2026-07-29T07:00:00.000Z",
        undoPolicyVersion: 3
      }
    ]
  };
}

function project(
  state: unknown = fixture(),
  threadId = "thread_trip",
  sourceId = "default"
): ContinuityGraphProjection {
  return projectContinuityState({
    scope: { sourceId, threadId },
    sourceObservedAt: SOURCE_OBSERVED_AT,
    state
  });
}

function canonicalJournal(
  projection: ContinuityGraphProjection
): readonly string[] {
  return projection.assertions
    .map((assertion) => JSON.stringify(assertion))
    .sort();
}

describe("Exact Continuity projection", () => {
  it("admits learning policy generation without projecting audit authority", () => {
    const policyBefore = {
      detail: "standard" as const,
      nextStep: "direct" as const,
      suppression: "none" as const,
      version: 0
    };
    const policyAfter = {
      detail: "compact" as const,
      nextStep: "contextual" as const,
      suppression: "none" as const,
      version: 1
    };
    const auditCore = {
      activeBehaviorDigestAfter: fingerprintContinuityPolicy(policyAfter),
      activeBehaviorDigestBefore: fingerprintContinuityPolicy(policyBefore),
      authority: "owner-explicit",
      candidateId: "candidate_private_learning",
      kind: "promotion",
      occurredAt: "2026-07-29T07:30:00.000Z",
      policyAfter,
      policyBefore,
      sourceId: "candidate_private_learning",
      threadId: "thread_learning"
    } as const;
    const audit: ExperienceLearningPolicyAudit = {
      ...auditCore,
      id: `learning_policy_audit_${createHash("sha256")
        .update(JSON.stringify(auditCore))
        .digest("hex")}`
    };
    const promotionHandle = createExperienceLearningPromotionHandle({
      activeBehaviorDigestAfter: audit.activeBehaviorDigestAfter,
      activeBehaviorDigestBefore: audit.activeBehaviorDigestBefore,
      appliedAt: audit.occurredAt,
      authority: audit.authority,
      candidateId: audit.candidateId,
      policyAfter,
      policyBefore,
      promotionAuditId: audit.id,
      promotionId: `learning_promotion_${"a".repeat(64)}`,
      threadId: audit.threadId
    });
    if (!promotionHandle) throw new Error("test promotion handle was invalid");
    const state: AttunementState = {
      deliveries: [],
      experienceLearningPolicyAudits: [audit],
      experienceLearningPromotionHandles: [promotionHandle],
      interactionReceipts: [],
      nextPolicyVersion: 2,
      resetReceipts: [],
      schemaVersion: 13,
      threads: [{
        createdAt: "2026-07-29T00:00:00.000Z",
        id: "thread_learning",
        kind: "work",
        links: [],
        policy: policyAfter,
        title: "Private learning title"
      }],
      undoResetReceipts: []
    };

    const prepared = prepareContinuitySourceObservation({
      scope: { sourceId: "default", threadId: "thread_learning" },
      sourceObservedAt: SOURCE_OBSERVED_AT,
      state
    }, "current");

    expect(prepared.diagnostics.sourceRecordsInspected).toBe(3);
    expect(prepared.projection.assertions).toHaveLength(1);
    expect(prepared.projection.assertions[0]).toMatchObject({
      predicate: "SCOPED_TO",
      recordedAt: audit.occurredAt,
      sourceRefs: [
        { namespace: CONTINUITY_SOURCE_NAMESPACES.threadPolicy }
      ],
      validFrom: audit.occurredAt
    });
    const serialized = JSON.stringify(prepared.projection);
    expect(serialized).not.toContain(audit.id);
    expect(serialized).not.toContain(audit.candidateId);
    expect(serialized).not.toContain(audit.activeBehaviorDigestBefore);
    expect(serialized).not.toContain(audit.activeBehaviorDigestAfter);
    expect(serialized).not.toContain(promotionHandle.handleId);
  });

  it("projects one thread deterministically with exact provenance and no personal text", async () => {
    const first = project();
    const replay = project();

    expect(replay).toEqual(first);
    expect(first.ruleVersion).toBe(CONTINUITY_PROJECTION_RULE_VERSION);
    expect(first.assertions).toHaveLength(19);
    expect(first.assertions.map((assertion) => assertion.id))
      .toEqual([...first.assertions.map((assertion) => assertion.id)].sort());
    expect(first.assertions.every((assertion) =>
      assertion.sourceRefs.length > 0
      && assertion.sourceRefs.every((sourceRef) =>
        sourceRef.version?.startsWith("sha256:")
      )
      && assertion.derivation.version === CONTINUITY_PROJECTION_RULE_VERSION
    )).toBe(true);

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("Private trip title");
    expect(serialized).not.toContain("private owner reason");

    const store = new InMemoryAttuneGraphDataStore();
    await expect(store.append(first.assertions)).resolves.toMatchObject({
      appended: 19,
      replayed: 0
    });
    await expect(store.append(replay.assertions)).resolves.toMatchObject({
      appended: 0,
      replayed: 19
    });
    await expect(store.verify()).resolves.toMatchObject({ ok: true });
  });

  it("keeps explicit outcomes separate from factual interaction evidence", () => {
    const projection = project();
    const outcomes = projection.assertions.filter((assertion) =>
      assertion.predicate === "PRODUCED_OUTCOME"
    );
    const interactionSources = projection.assertions.filter((assertion) =>
      assertion.sourceRefs.some((sourceRef) =>
        sourceRef.namespace === CONTINUITY_SOURCE_NAMESPACES.interaction
      )
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.sourceRefs).toEqual([
      expect.objectContaining({
        namespace: CONTINUITY_SOURCE_NAMESPACES.outcome
      })
    ]);
    expect(interactionSources.map((assertion) => assertion.predicate).sort())
      .toEqual(["CORRELATES_WITH", "OBSERVED_DURING"]);
    expect(interactionSources.some((assertion) =>
      assertion.predicate === "PRODUCED_OUTCOME"
    )).toBe(false);
  });

  it("uses source observation only for undated reset provenance", () => {
    const projection = project();
    const resetRevision = projection.assertions.find((assertion) =>
      assertion.predicate === "SUPERSEDES"
      && assertion.sourceRefs.some((sourceRef) =>
        sourceRef.namespace === CONTINUITY_SOURCE_NAMESPACES.policyReset
      )
    );

    expect(resetRevision).toMatchObject({
      recordedAt: SOURCE_OBSERVED_AT
    });
    expect(resetRevision).not.toHaveProperty("validFrom");
    expect(projection.timestampBasis).toContainEqual({
      basis: "source-observation",
      sourceRef: expect.objectContaining({
        namespace: CONTINUITY_SOURCE_NAMESPACES.policyReset
      })
    });
  });

  it("does not churn when excluded title or owner-note content changes", () => {
    const state = fixture();
    const changed: AttunementState = {
      ...state,
      deliveries: state.deliveries.map((delivery, index) =>
        index === 0 && delivery.outcome
          ? {
              ...delivery,
              outcome: {
                ...delivery.outcome,
                ownerNote: "different private reason"
              }
            }
          : delivery
      ),
      threads: state.threads.map((thread, index) =>
        index === 0 ? { ...thread, title: "Different private title" } : thread
      )
    };

    expect(project(changed)).toEqual(project(state));
  });

  it("treats delivery evidence as a set for identity and delta stability", () => {
    const state = fixture();
    const reordered: AttunementState = {
      ...state,
      deliveries: state.deliveries.map((delivery) => ({
        ...delivery,
        evidenceRefs: [...delivery.evidenceRefs].reverse()
      }))
    };

    expect(project(reordered)).toEqual(project(state));
    expect(diffContinuityProjections(project(state), project(reordered)))
      .toMatchObject({
        append: [],
        forgetAssertionIds: []
      });
  });

  it("diffs minimal assertion sets and converges with a clean rebuild", async () => {
    const beforeState = fixture();
    const afterState: AttunementState = {
      ...beforeState,
      threads: beforeState.threads.map((thread) =>
        thread.id === "thread_trip"
          ? {
              ...thread,
              links: thread.links.filter((link) => link.artifactType !== "note")
            }
          : thread
      )
    };
    const before = project(beforeState);
    const after = project(afterState);
    const delta = diffContinuityProjections(before, after);

    expect(delta.forgetAssertionIds).toHaveLength(1);
    expect(delta.append).toEqual([]);
    expect(delta.unchangedAssertionIds).toHaveLength(before.assertions.length - 1);

    const incremental = new InMemoryAttuneGraphDataStore();
    await incremental.append(before.assertions);
    await incremental.forget({ assertionIds: delta.forgetAssertionIds });
    if (delta.append.length > 0) await incremental.append(delta.append);

    const rebuilt = new InMemoryAttuneGraphDataStore();
    await rebuilt.append(after.assertions);
    expect(
      (await incremental.journal()).map((assertion) => JSON.stringify(assertion)).sort()
    ).toEqual(
      (await rebuilt.journal()).map((assertion) => JSON.stringify(assertion)).sort()
    );
    expect(canonicalJournal(after)).toEqual(
      (await rebuilt.journal()).map((assertion) => JSON.stringify(assertion)).sort()
    );
  });

  it("changes only represented assertions and ignores another thread", () => {
    const beforeState = fixture();
    const relinked: AttunementState = {
      ...beforeState,
      threads: beforeState.threads.map((thread) =>
        thread.id === "thread_trip"
          ? {
              ...thread,
              links: thread.links.map((link) =>
                link.artifactType === "note"
                  ? { ...link, linkedAt: "2026-07-29T01:02:00.000Z" }
                  : link
              )
            }
          : thread
      )
    };
    const relevantDelta = diffContinuityProjections(
      project(beforeState),
      project(relinked)
    );
    expect(relevantDelta.append).toHaveLength(1);
    expect(relevantDelta.forgetAssertionIds).toHaveLength(1);

    const otherThreadChanged: AttunementState = {
      ...beforeState,
      threads: beforeState.threads.map((thread) =>
        thread.id === "thread_work"
          ? {
              ...thread,
              links: [{
                artifactId: "work/context.md",
                artifactType: "note",
                linkedAt: "2026-07-29T01:30:00.000Z",
                linkedBy: "user",
                providerId: "local",
                role: "context",
                threadId: "thread_work"
              }]
            }
          : thread
      )
    };
    expect(project(otherThreadChanged)).toEqual(project(beforeState));
  });

  it("isolates thread/source scopes and rejects malformed or cross-thread state", () => {
    const trip = project();
    const work = project(fixture(), "thread_work");
    const otherSource = project(fixture(), "thread_trip", "another-store");
    expect(work.assertions).toHaveLength(1);

    expect(() => diffContinuityProjections(trip, work)).toThrow(
      expect.objectContaining({ code: "SCOPE_MISMATCH" })
    );
    expect(() => diffContinuityProjections(trip, otherSource)).toThrow(
      expect.objectContaining({ code: "SCOPE_MISMATCH" })
    );
    expect(() => project({ schemaVersion: 11 })).toThrow(
      expect.objectContaining({ code: "INVALID_STATE" })
    );

    const crossThreadState = fixture();
    const crossThread: AttunementState = {
      ...crossThreadState,
      threads: crossThreadState.threads.map((thread) =>
        thread.id === "thread_trip"
          ? {
              ...thread,
              links: thread.links.map((link, index) =>
                index === 0 ? { ...link, threadId: "thread_work" } : link
              )
            }
          : thread
      )
    };
    expect(() => project(crossThread)).toThrow(
      expect.objectContaining({ code: "INVALID_STATE" })
    );
  });

  it("detects same-id content collisions before producing a delta", () => {
    const previous = project();
    const next = project();
    const tampered = {
      ...next,
      assertions: next.assertions.map((assertion, index) =>
        index === 0
          ? { ...assertion, recordedAt: "2026-07-29T09:00:00.000Z" }
          : assertion
      )
    };

    expect(() => diffContinuityProjections(previous, tampered)).toThrow(
      expect.objectContaining({
        code: "ASSERTION_COLLISION",
        name: "ContinuityProjectionError"
      })
    );

    const newAssertion = {
      ...next.assertions[0]!,
      id: "adversarial_new_id"
    };
    const duplicateNewId = {
      ...newAssertion,
      recordedAt: "2026-07-29T10:00:00.000Z"
    };
    expect(() => diffContinuityProjections(previous, {
      ...next,
      assertions: [newAssertion, duplicateNewId]
    })).toThrow(expect.objectContaining({ code: "ASSERTION_COLLISION" }));
  });

  it("rejects invalid source envelopes without reading a store or clock", () => {
    expect(() => projectContinuityState({
      scope: { sourceId: " default ", threadId: "thread_trip" },
      sourceObservedAt: SOURCE_OBSERVED_AT,
      state: fixture()
    })).toThrow(ContinuityProjectionError);
    expect(() => projectContinuityState({
      scope: { sourceId: "default", threadId: "thread_trip" },
      sourceObservedAt: "not-a-time",
      state: fixture()
    })).toThrow(expect.objectContaining({ code: "INVALID_SOURCE" }));
    expect(() => project(fixture(), "thread_trip", "/Users/me/.muse/state.json"))
      .toThrow(expect.objectContaining({ code: "INVALID_SOURCE" }));
    expect(() => project(fixture(), "thread_trip", "C:\\Muse\\state.json"))
      .toThrow(expect.objectContaining({ code: "INVALID_SOURCE" }));
    expect(() => project(fixture(), "thread_trip", "C:state.json"))
      .toThrow(expect.objectContaining({ code: "INVALID_SOURCE" }));
  });

  it("shares malformed-state rejection and legacy normalization with the store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-graph-projection-"));
    const file = join(directory, "attunement.json");
    try {
      const withoutPolicyAudits = {
        ...fixture()
      } as Record<string, unknown>;
      delete withoutPolicyAudits.experienceLearningPolicyAudits;
      const invalidCases: unknown[] = [
        { schemaVersion: 11 },
        {
          ...fixture(),
          threads: fixture().threads.map((thread, index) =>
            index === 0 ? { ...thread, kind: "invalid-kind" } : thread
          )
        },
        withoutPolicyAudits,
        {
          ...fixture(),
          threads: fixture().threads.map((thread, index) =>
            index === 0
              ? {
                  ...thread,
                  links: thread.links.map((link, linkIndex) =>
                    linkIndex === 0 ? { ...link, threadId: "thread_work" } : link
                  )
                }
              : thread
          )
        },
        {
          ...fixture(),
          deliveries: fixture().deliveries.map((delivery, index) =>
            index === 0
              ? {
                  ...delivery,
                  evidenceRefs: [
                    delivery.evidenceRefs[0]!,
                    delivery.evidenceRefs[0]!
                  ]
                }
              : delivery
          )
        }
      ];
      for (const invalid of invalidCases) {
        await writeFile(file, JSON.stringify(invalid), "utf8");
        await expect(readAttunementState(file)).rejects.toBeInstanceOf(
          AttunementStoreError
        );
        expect(() => project(invalid)).toThrow(
          expect.objectContaining({ code: "INVALID_STATE" })
        );
      }

      const legacy = { ...withoutPolicyAudits, schemaVersion: 2 };
      await writeFile(file, JSON.stringify(legacy), "utf8");
      const normalized = await readAttunementState(file);
      expect(normalized.schemaVersion).toBe(13);
      expect(project(legacy)).toEqual(project(normalized));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
