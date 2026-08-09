import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalArtifactValidator,
  createExperienceReplayEvidenceReceipt,
  createPersonalThread,
  linkArtifact,
  readAttunementState,
  type ExperienceLearningRollbackProposal
} from "@muse/attunement";
import {
  createContinuityAttuneGraphProjector
} from "@muse/attunegraph/continuity-durable-projection";
import {
  captureContinuityObservation
} from "@muse/attunegraph/continuity-observations";
import { sha256Hex } from "@muse/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createContinuityLearningPreviewTool
} from "../src/continuity-learning-preview-tool.js";
import {
  createContinuityLearningReplayPreviewTool
} from "../src/continuity-learning-replay-preview-tool.js";
import {
  createContinuityLearningApplyTool
} from "../src/continuity-learning-apply-tool.js";
import {
  createContinuityLearningDegradationTool
} from "../src/continuity-learning-degradation-tool.js";
import {
  createContinuityLearningRollbackTool
} from "../src/continuity-learning-rollback-tool.js";
import { createMuseRuntimeAssembly } from "../src/index.js";

const projectorHarness = vi.hoisted(() => {
  let generation = 0;
  const projections = new Map<string, Readonly<{
    readonly observationReceiptId: string;
    readonly schemaVersion: 1;
    readonly snapshot: Readonly<{
      readonly commitId: string;
      readonly generation: number;
      readonly schemaVersion: 1;
      readonly scope: Readonly<{ readonly sourceId: string; readonly threadId: string }>;
    }>;
    readonly sourceFreshness: Readonly<{
      readonly observedAt: string;
      readonly state: "unknown";
    }>;
    readonly status: "projected";
  }>>();
  const project = vi.fn(async (value: unknown) => {
    const receipt = value as Readonly<{
      readonly observedAt: string;
      readonly projection: Readonly<{
        readonly scope: Readonly<{ readonly sourceId: string; readonly threadId: string }>;
      }>;
      readonly receiptId: string;
    }>;
    const existing = projections.get(receipt.receiptId);
    if (existing) return Object.freeze({ ...existing, status: "replayed" as const });
    generation += 1;
    const result = Object.freeze({
      observationReceiptId: receipt.receiptId,
      schemaVersion: 1 as const,
      snapshot: Object.freeze({
        commitId: `attunegraph-commit:test-${generation.toString()}`,
        generation,
        schemaVersion: 1 as const,
        scope: Object.freeze({ ...receipt.projection.scope })
      }),
      sourceFreshness: Object.freeze({
        observedAt: receipt.observedAt,
        state: "unknown" as const
      }),
      status: "projected" as const
    });
    projections.set(receipt.receiptId, result);
    return result;
  });
  const create = vi.fn(() => Object.freeze({ project }));
  return {
    create,
    project,
    reset() {
      generation = 0;
      projections.clear();
      create.mockClear();
      project.mockClear();
    }
  };
});

vi.mock("@muse/attunegraph/continuity-durable-projection", () => ({
  createContinuityAttuneGraphProjector: projectorHarness.create
}));

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
  projectorHarness.reset();
});

describe("continuity learning preview tool", () => {
  it("revalidates a current queue opportunity and returns an activation-none preview without writes", async () => {
    directory = await realpath(
      await mkdtemp(join(tmpdir(), "muse-learning-preview-"))
    );
    const attunementFile = join(directory, "attunement.json");
    const attuneGraphFile = join(directory, "attunegraph.sqlite");
    const notesDir = join(directory, "notes");
    const tasksFile = join(directory, "tasks.json");
    const task = {
      createdAt: "2026-07-30T00:00:00.000Z",
      id: "task_learning_preview",
      status: "open",
      title: "Review the learning proposal"
    } as const;
    await writeFile(tasksFile, JSON.stringify({ tasks: [task] }));
    const thread = await createPersonalThread(attunementFile, {
      kind: "work",
      title: "Agent learning"
    });
    await linkArtifact(attunementFile, {
      artifactId: task.id,
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    }, {
      validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile })
    });
    const assembly = createMuseRuntimeAssembly({
      env: {
        HOME: directory,
        MUSE_ATTUNEGRAPH_DATABASE: attuneGraphFile,
        MUSE_ATTUNEMENT_FILE: attunementFile,
        MUSE_NOTES_DIR: notesDir,
        MUSE_TASKS_FILE: tasksFile
      }
    });
    const tool = (name: string) => assembly.toolRegistry.list().find(
      (entry) => entry.definition.name === name
    )!;
    const packPreview = await tool("muse.continuity.pack.preview").execute(
      { threadId: thread.id },
      { runId: "preview-pack" }
    );
    const opened = await tool("muse.continuity.pack.open").execute({
      previewDigest: (packPreview as { readonly previewDigest: string }).previewDigest,
      threadId: thread.id
    }, { runId: "open-pack" });
    const deliveryId = (opened as { readonly delivery: { readonly id: string } })
      .delivery.id;
    expect(opened).toMatchObject({
      delivery: { runId: "open-pack" }
    });
    await tool("muse.continuity.delivery.outcome").execute({
      deliveryId,
      outcome: "adjusted",
      ownerNote: "Keep the next step but show less context."
    }, { runId: "record-outcome" });
    const queue = await tool("muse.continuity.learning.opportunities").execute(
      {},
      { runId: "read-queue" }
    );
    expect(queue).toMatchObject({
      items: [{ sourceRun: { runId: "open-pack" } }]
    });
    const opportunityId = (
      queue as { readonly items: readonly { readonly opportunityId: string }[] }
    ).items[0]!.opportunityId;
    const recordedAt = (await readAttunementState(attunementFile))
      .deliveries[0]!.outcome!.recordedAt;
    const proposedAt = recordedAt;
    const expiresAt = new Date(Date.parse(proposedAt) + 24 * 60 * 60_000).toISOString();
    const before = await readFile(attunementFile);
    const draft = {
      expectedBenefit: "Restore context with less reading.",
      expiresAt,
      experienceId: "agent-learning-preview-1",
      proposedAt,
      proposedBehavior: "Use a compact Pack while preserving the exact next step.",
      proposedChange: {
        detail: "compact",
        kind: "thread-display",
        nextStep: "contextual"
      },
      scope: {
        kind: "thread-display",
        threadId: thread.id
      }
    };

    const result = await tool("muse.continuity.learning.preview").execute({
      draft,
      opportunityId
    }, { runId: "preview-learning" });

    expect(result).toMatchObject({
      boundary: {
        actionScope: "not-expanded",
        activation: "none",
        permission: "unchanged",
        recipient: "unchanged",
        source: "unchanged"
      },
      evidence: {
        outcome: { outcome: "adjusted" },
        sourceRun: { evidenceClass: "organic-production" }
      },
      proposedChange: {
        detail: "compact",
        kind: "thread-display",
        nextStep: "contextual"
      }
    });
    expect(await readFile(attunementFile)).toEqual(before);

    const evidenceObservedAt = proposedAt;
    const evidenceCases = Array.from({ length: 10 }, (_, index) => {
      const caseId = `agent-replay-${index.toString()}`;
      const common = {
        caseId,
        evaluator: { id: "continuity-terminal-grader", version: "1.0.0" },
        inputHash: "f".repeat(64),
        observedAt: evidenceObservedAt
      };
      return {
        baseline: createExperienceReplayEvidenceReceipt({
          ...common,
          passed: index !== 0,
          variant: "baseline"
        }),
        caseId,
        challenger: createExperienceReplayEvidenceReceipt({
          ...common,
          passed: true,
          variant: "challenger"
        })
      };
    });
    const replay = await tool("muse.continuity.learning.replay-preview").execute({
      draft,
      evidenceCases,
      opportunityId
    }, { runId: "preview-replay" });
    expect(replay).toMatchObject({
      preview: {
        boundary: { activation: "none" },
        previewId: (result as { readonly previewId: string }).previewId
      },
      replayBundle: {
        replay: {
          aggregate: {
            improvements: 1,
            regressions: 0,
            total: 10
          },
          promotionApplied: false,
          recommendation: "eligible-for-review",
          replayStatus: "frozen"
        },
        status: "frozen"
      }
    });
    expect(await readFile(attunementFile)).toEqual(before);

    const graphReceipt = captureContinuityObservation({
      scope: {
        sourceId: "muse.local-attunement",
        threadId: thread.id
      },
      sourceObservedAt: new Date(
        Date.parse(recordedAt) + 1_000
      ).toISOString(),
      state: await readAttunementState(attunementFile)
    });
    const graphProjector = createContinuityAttuneGraphProjector({
      databasePath: attuneGraphFile
    });
    const graphSeed = await graphProjector.project(graphReceipt);
    const attunementBeforePolicyCard = await readFile(attunementFile);
    const graphProjectionCallsBeforePolicyCard =
      projectorHarness.project.mock.calls.length;
    const policyCard = await tool(
      "muse.continuity.learning.policy-card.preview"
    ).execute({
      draft,
      evidenceCases,
      locale: "ko",
      opportunityId
    }, { runId: "preview-policy-card" });
    expect(policyCard).toMatchObject({
      card: {
        assessedSnapshot: {
          currentWorldFreshness: false,
          providerAttestedDerivedGraph: false
        },
        boundary: {
          activation: "none",
          approval: "none",
          effect: "none"
        },
        evidence: {
          authoritativeExperience: {
            evidenceClass: "organic-production"
          },
          callerSuppliedReplayClaims: {
            executionProvenanceVerified: false
          },
          graphExplanation: {
            providerAttested: false
          }
        },
        locale: "ko"
      },
      status: "rendered"
    });
    expect(await readFile(attunementFile)).toEqual(attunementBeforePolicyCard);
    expect(projectorHarness.project).toHaveBeenCalledTimes(
      graphProjectionCallsBeforePolicyCard
    );

    const heldPolicyCard = await tool(
      "muse.continuity.learning.policy-card.preview"
    ).execute({
      draft,
      evidenceCases: [],
      locale: "ko",
      opportunityId
    }, { runId: "preview-held-policy-card" });
    expect(heldPolicyCard).toEqual({
      reason: "replay-invalid",
      status: "held"
    });
    expect(await readFile(attunementFile)).toEqual(attunementBeforePolicyCard);
    expect(projectorHarness.project).toHaveBeenCalledTimes(
      graphProjectionCallsBeforePolicyCard
    );
    const graphReplay = await graphProjector.project(graphReceipt);
    expect(graphReplay).toMatchObject({
      snapshot: graphSeed.snapshot,
      status: "replayed"
    });

    const applyTool = tool("muse.continuity.learning.apply");
    expect(applyTool.definition.risk).toBe("write");
    const applied = await applyTool.execute({
      draft,
      evidenceCases,
      opportunityId,
      previewId: (result as { readonly previewId: string }).previewId,
      replayInputHash: (
        replay as {
          readonly replayBundle: { readonly replay: { readonly inputHash: string } };
        }
      ).replayBundle.replay.inputHash
    }, { runId: "apply-learning" });
    expect(applied).toMatchObject({
      approval: {
        authority: "owner-explicit",
        previewId: (result as { readonly previewId: string }).previewId
      },
      handleId: expect.stringMatching(
        /^learning_promotion_handle_[a-f0-9]{64}$/u
      ),
      policyAuditId: expect.stringMatching(/^learning_policy_audit_[a-f0-9]{64}$/u),
      promotion: {
        policyAfter: {
          detail: "compact",
          nextStep: "contextual"
        },
        promotionApplied: true
      }
    });
    expect(assembly.observability.adaptationLoopHealthSnapshot()).toEqual({
      evidenceId: (
        applied as { readonly promotion: { readonly promotionId: string } }
      ).promotion.promotionId,
      evidenceVerified: true,
      status: "promoted"
    });
    const appliedState = await readAttunementState(attunementFile);
    expect(appliedState.experienceLearningPolicyAudits).toHaveLength(1);
    expect(appliedState.threads.find((entry) => entry.id === thread.id)?.policy)
      .toMatchObject({ detail: "compact", nextStep: "contextual" });
    const afterApply = await readFile(attunementFile);
    await expect(applyTool.execute({
      draft,
      evidenceCases,
      opportunityId,
      previewId: (result as { readonly previewId: string }).previewId,
      replayInputHash: (
        replay as {
          readonly replayBundle: { readonly replay: { readonly inputHash: string } };
        }
      ).replayBundle.replay.inputHash
    }, { runId: "replay-apply" })).rejects.toThrow(/held/u);
    expect(await readFile(attunementFile)).toEqual(afterApply);

    const rollbackTool = tool("muse.continuity.learning.rollback");
    expect(rollbackTool.definition.risk).toBe("write");
    const handleId = (applied as { readonly handleId: string }).handleId;
    const degradationTool = tool("muse.continuity.learning.degradation");
    expect(degradationTool.definition.risk).toBe("read");
    const beforeAssessment = await readFile(attunementFile);
    await expect(degradationTool.execute(
      { handleId },
      { runId: "assess-learning" }
    )).resolves.toMatchObject({
      handleId,
      reason: "insufficient-window",
      status: "hold"
    });
    expect(await readFile(attunementFile)).toEqual(beforeAssessment);
    const beforeForgedRollback = await readFile(attunementFile);
    await expect(rollbackTool.execute(
      { handleId: `learning_promotion_handle_${"f".repeat(64)}` },
      { runId: "forged-self-consistent-rollback" }
    )).rejects.toThrow(/held/u);
    expect(await readFile(attunementFile)).toEqual(beforeForgedRollback);
    const rolledBack = await rollbackTool.execute(
      { handleId: handleId! },
      { runId: "rollback-learning" }
    );
    expect(rolledBack).toMatchObject({
      policyAuditId: expect.stringMatching(/^learning_policy_audit_[a-f0-9]{64}$/u),
      rollback: {
        policyAfter: {
          detail: "standard",
          nextStep: "contextual"
        },
        rollbackApplied: true
      }
    });
    const rolledBackState = await readAttunementState(attunementFile);
    expect(rolledBackState.experienceLearningPolicyAudits).toHaveLength(2);
    expect(rolledBackState.threads.find((entry) => entry.id === thread.id)?.policy)
      .toMatchObject({ detail: "standard", nextStep: "contextual" });
    const afterRollback = await readFile(attunementFile);
    await expect(rollbackTool.execute(
      { handleId: handleId! },
      { runId: "replay-rollback" }
    )).rejects.toThrow();
    await expect(rollbackTool.execute({
      handleId: `learning_promotion_handle_${"e".repeat(64)}`
    }, { runId: "tampered-rollback" })).rejects.toThrow();
    expect(await readFile(attunementFile)).toEqual(afterRollback);

    await expect(tool("muse.continuity.learning.preview").execute({
      draft: {
        expectedBenefit: "Wrong scope.",
        expiresAt,
        experienceId: "agent-learning-preview-wrong-scope",
        proposedAt,
        proposedBehavior: "Change another thread.",
        proposedChange: {
          detail: "compact",
          kind: "thread-display",
          nextStep: "contextual"
        },
        scope: {
          kind: "thread-display",
          threadId: "thread-other"
        }
      },
      opportunityId
    }, { runId: "held-scope" })).rejects.toThrow(/held/u);
    expect(await readFile(attunementFile)).toEqual(afterRollback);
  });

  it("rejects non-plain, extra, stale, and malformed input before producing a preview", async () => {
    const preview = vi.fn(async () => undefined);
    const tool = createContinuityLearningPreviewTool({ preview });
    const validDraft = {
      expectedBenefit: "Less interruption.",
      expiresAt: "2026-07-31T12:00:00.000Z",
      experienceId: "preview-1",
      proposedAt: "2026-07-30T12:00:00.000Z",
      proposedBehavior: "Wait longer.",
      proposedChange: {
        adjustment: "increase-cooldown",
        kind: "thread-timing"
      },
      scope: {
        kind: "thread-timing",
        threadId: "thread-1"
      }
    };
    const opportunityId = `learning_opportunity_${"a".repeat(64)}`;
    await expect(tool.execute({
      draft: validDraft,
      opportunityId
    }, { runId: "stale" })).rejects.toThrow(/held/u);
    expect(preview).toHaveBeenCalledTimes(1);

    for (const input of [
      { draft: validDraft, extra: true, opportunityId },
      { draft: { ...validDraft, extra: true }, opportunityId },
      { draft: validDraft, opportunityId: "learning_opportunity_invalid" },
      []
    ]) {
      await expect(tool.execute(input as never, { runId: "invalid" })).rejects.toThrow();
    }
    const proxy = new Proxy({ draft: validDraft, opportunityId }, {});
    await expect(tool.execute(proxy, { runId: "proxy" })).rejects.toThrow();
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("holds malformed, extra, proxy, and insufficient replay input without creating evidence", async () => {
    const previewReplay = vi.fn(async () => undefined);
    const tool = createContinuityLearningReplayPreviewTool({ previewReplay });
    const draft = {
      expectedBenefit: "Less interruption.",
      expiresAt: "2026-07-31T12:00:00.000Z",
      experienceId: "preview-replay-1",
      proposedAt: "2026-07-30T12:00:00.000Z",
      proposedBehavior: "Wait longer.",
      proposedChange: {
        adjustment: "increase-cooldown",
        kind: "thread-timing"
      },
      scope: {
        kind: "thread-timing",
        threadId: "thread-1"
      }
    };
    const opportunityId = `learning_opportunity_${"a".repeat(64)}`;

    await expect(tool.execute({
      draft,
      evidenceCases: [],
      opportunityId
    }, { runId: "insufficient" })).rejects.toThrow(/held/u);
    expect(previewReplay).toHaveBeenCalledTimes(1);

    for (const input of [
      { draft, evidenceCases: {}, opportunityId },
      { draft, evidenceCases: [], extra: true, opportunityId },
      { draft: { ...draft, extra: true }, evidenceCases: [], opportunityId }
    ]) {
      await expect(tool.execute(input as never, { runId: "invalid" })).rejects.toThrow();
    }
    await expect(tool.execute(
      new Proxy({ draft, evidenceCases: [], opportunityId }, {}),
      { runId: "proxy" }
    )).rejects.toThrow();
    expect(previewReplay).toHaveBeenCalledTimes(1);
  });

  it("binds apply to exact preview and replay ids before the write dependency", async () => {
    const apply = vi.fn(async () => undefined);
    const tool = createContinuityLearningApplyTool({ apply });
    const draft = {
      expectedBenefit: "Less interruption.",
      expiresAt: "2026-07-31T12:00:00.000Z",
      experienceId: "apply-1",
      proposedAt: "2026-07-30T12:00:00.000Z",
      proposedBehavior: "Wait longer.",
      proposedChange: {
        adjustment: "increase-cooldown",
        kind: "thread-timing"
      },
      scope: {
        kind: "thread-timing",
        threadId: "thread-1"
      }
    };
    const valid = {
      draft,
      evidenceCases: [],
      opportunityId: `learning_opportunity_${"a".repeat(64)}`,
      previewId: `learning_preview_${"b".repeat(64)}`,
      replayInputHash: "c".repeat(64)
    };
    expect(tool.definition.risk).toBe("write");
    await expect(tool.execute(valid, { runId: "held" })).rejects.toThrow(/held/u);
    expect(apply).toHaveBeenCalledTimes(1);

    for (const input of [
      { ...valid, previewId: "learning_preview_invalid" },
      { ...valid, replayInputHash: "short" },
      { ...valid, extra: true }
    ]) {
      await expect(tool.execute(input as never, { runId: "invalid" })).rejects.toThrow();
    }
    await expect(tool.execute(
      new Proxy(valid, {}),
      { runId: "proxy" }
    )).rejects.toThrow();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("requires one exact promotion handle ID before the rollback dependency", async () => {
    const rollback = vi.fn(async () => undefined);
    const tool = createContinuityLearningRollbackTool({ rollback });
    expect(tool.definition.risk).toBe("write");
    await expect(tool.execute({
      handleId: `learning_promotion_handle_${"a".repeat(64)}`
    }, { runId: "held" })).rejects.toThrow(/held/u);
    expect(rollback).toHaveBeenCalledTimes(1);
    for (const input of [
      {},
      { handleId: "learning_promotion_handle_invalid" },
      { handleId: `learning_promotion_handle_${"b".repeat(64)}`, extra: true },
      { promotion: {} }
    ]) {
      await expect(tool.execute(input as never, { runId: "invalid" })).rejects.toThrow();
    }
    await expect(tool.execute(
      new Proxy({ handleId: `learning_promotion_handle_${"c".repeat(64)}` }, {}),
      { runId: "proxy" }
    )).rejects.toThrow();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it("requires one exact promotion handle ID before read-only degradation assessment", async () => {
    const handleId = `learning_promotion_handle_${"a".repeat(64)}`;
    const baselineOutcomeIds = Array.from(
      { length: 5 },
      (_, index) => `continuity_outcome_${sha256Hex(`baseline:${index}`)}`
    );
    const promotedOutcomeIds = Array.from(
      { length: 5 },
      (_, index) => `continuity_outcome_${sha256Hex(`promoted:${index}`)}`
    );
    const proposalCore = {
      authority: "none" as const,
      baselineOutcomeIds,
      criteriaVersion: 1 as const,
      effectPerformed: false as const,
      handleId,
      ownerApprovalRequired: true as const,
      promotedOutcomeIds,
      reason: "post-promotion-regression" as const,
      schemaVersion: 1 as const,
      status: "proposed" as const
    };
    const proposal: ExperienceLearningRollbackProposal = Object.freeze({
      ...proposalCore,
      baselineOutcomeIds: Object.freeze(baselineOutcomeIds),
      promotedOutcomeIds: Object.freeze(promotedOutcomeIds),
      proposalId:
        `learning_rollback_proposal_${sha256Hex(JSON.stringify(proposalCore))}`
    });
    const assess = vi.fn(async () => ({
      baseline: { adjusted: 0, ignored: 0, rejected: 0, total: 0, used: 0 },
      handleId,
      promoted: { adjusted: 0, ignored: 0, rejected: 0, total: 0, used: 0 },
      reason: "insufficient-window" as const,
      requiredOutcomesPerWindow: 5 as const,
      status: "hold" as const
    }));
    const observeProposal = vi.fn(() => {
      throw new Error("health observer unavailable");
    });
    const tool = createContinuityLearningDegradationTool({
      assess,
      observeProposal
    });
    expect(tool.definition.risk).toBe("read");
    await expect(tool.execute({ handleId }, { runId: "read" }))
      .resolves.toMatchObject({ handleId, status: "hold" });
    assess.mockResolvedValueOnce({
      baseline: { adjusted: 0, ignored: 0, rejected: 0, total: 5, used: 5 },
      handleId,
      promoted: { adjusted: 0, ignored: 0, rejected: 1, total: 5, used: 2 },
      proposal,
      reason: "post-promotion-regression",
      requiredOutcomesPerWindow: 5,
      status: "propose-rollback"
    });
    await expect(tool.execute({ handleId }, { runId: "proposal" }))
      .resolves.toMatchObject({ proposal, status: "propose-rollback" });
    expect(observeProposal).toHaveBeenCalledWith(proposal);
    assess.mockResolvedValueOnce(undefined);
    await expect(tool.execute({ handleId }, { runId: "missing" }))
      .rejects.toThrow(/unavailable/u);
    for (const input of [
      {},
      { handleId: "invalid" },
      { handleId, extra: true },
      { promotion: {} }
    ]) {
      await expect(tool.execute(input as never, { runId: "invalid" })).rejects.toThrow();
    }
    await expect(tool.execute(
      new Proxy({ handleId }, {}),
      { runId: "proxy" }
    )).rejects.toThrow();
    expect(assess).toHaveBeenCalledTimes(3);
  });
});
