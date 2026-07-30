import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalArtifactValidator,
  createExperienceReplayEvidenceReceipt,
  createPersonalThread,
  linkArtifact,
  readAttunementState
} from "@muse/attunement";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createContinuityLearningPreviewTool
} from "../src/continuity-learning-preview-tool.js";
import {
  createContinuityLearningReplayPreviewTool
} from "../src/continuity-learning-replay-preview-tool.js";
import { createMuseRuntimeAssembly } from "../src/index.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

describe("continuity learning preview tool", () => {
  it("revalidates a current queue opportunity and returns an activation-none preview without writes", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-learning-preview-"));
    const attunementFile = join(directory, "attunement.json");
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
    await tool("muse.continuity.delivery.outcome").execute({
      deliveryId,
      outcome: "adjusted",
      ownerNote: "Keep the next step but show less context."
    }, { runId: "record-outcome" });
    const queue = await tool("muse.continuity.learning.opportunities").execute(
      {},
      { runId: "read-queue" }
    );
    const opportunityId = (
      queue as { readonly items: readonly { readonly opportunityId: string }[] }
    ).items[0]!.opportunityId;
    const recordedAt = (await readAttunementState(attunementFile))
      .deliveries[0]!.outcome!.recordedAt;
    const proposedAt = new Date(Date.parse(recordedAt) + 1_000).toISOString();
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

    const evidenceObservedAt = new Date(Date.parse(proposedAt) + 1_000).toISOString();
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
    expect(await readFile(attunementFile)).toEqual(before);
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
});
