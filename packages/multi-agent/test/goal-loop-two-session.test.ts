import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPersonalThread,
  linkWorkContinuity,
  setWorkContinuityThread
} from "@muse/attunement";
import {
  addWorkOutcome,
  createWork,
  getWork,
  linkWorkBoardTask,
  updateWork
} from "@muse/stores";
import {
  ToolExecutor,
  ToolRegistry,
  type MuseTool
} from "@muse/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  activateGoalPlan,
  assessGoalActionBudget,
  assessGoalActionResume,
  createGoalActionTerminalReceipt,
  createGoalCheckpointBinding,
  createGoalDecompositionDraft,
  inspectGoalCheckpointResume,
  projectGoalProgress,
  selectNextReadyGoalAction
} from "../src/index.js";

const WORK_ID = "work_11111111-1111-4111-8111-111111111111";
const EVIDENCE_A = `sha256:${"a".repeat(64)}`;
const EVIDENCE_B = `sha256:${"b".repeat(64)}`;
const ZERO_USAGE = {
  attempts: 0,
  effects: 0,
  modelCalls: 0,
  toolCalls: 0,
  wallTimeMs: 0
};
const LIMITS = {
  attempts: 2,
  effects: 1,
  modelCalls: 2,
  toolCalls: 2,
  wallTimeMs: 60_000
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

describe("Core100 deterministic two-session goal loop", () => {
  it("preserves continuity truth and resumes only exact source-backed progress without duplicate effects", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-goal-two-session-"));
    const workFile = join(directory, "works.json");
    const attunementFile = join(directory, "attunement.json");
    await createWork(workFile, {
      goal: "Produce a source-backed report",
      name: "Daily report"
    }, process.env, {
      idFactory: () => WORK_ID,
      now: () => new Date("2026-07-28T00:00:00.000Z")
    });
    const thread = await createPersonalThread(attunementFile, {
      kind: "work",
      title: "Daily report"
    }, {
      idFactory: () => "daily_report",
      now: () => new Date("2026-07-28T00:00:00.000Z")
    });
    const continuityFiles = { attunementFile, worksFile: workFile };
    await linkWorkContinuity(continuityFiles, { threadId: thread.id, workId: WORK_ID });
    await setWorkContinuityThread(continuityFiles, { threadId: thread.id, workId: WORK_ID });
    await linkWorkBoardTask(workFile, WORK_ID, "task_source_1", () => true);
    await addWorkOutcome(workFile, WORK_ID, {
      atIso: "2026-07-28T00:01:00.000Z",
      kind: "adjusted",
      note: "Owner narrowed the report"
    });

    // Session 1: changing project execution state must not rewrite its linked
    // conversation, exact evidence reference, or owner outcome.
    const beforeProjectMutation = await getWork(workFile, WORK_ID);
    const beforeContinuityBytes = await readFile(attunementFile);
    await updateWork(workFile, WORK_ID, { status: "paused" });
    const afterProjectMutation = await getWork(workFile, WORK_ID);
    const afterContinuityBytes = await readFile(attunementFile);
    expect(afterProjectMutation).toMatchObject({ status: "paused" });
    expect(afterProjectMutation?.threadId).toBe(beforeProjectMutation?.threadId);
    expect(afterProjectMutation?.boardTaskIds).toEqual(beforeProjectMutation?.boardTaskIds);
    expect(afterProjectMutation?.outcomes).toEqual(beforeProjectMutation?.outcomes);
    expect(afterContinuityBytes).toEqual(beforeContinuityBytes);

    const draft = createGoalDecompositionDraft("Research exact sources first. Then write the report.");
    const plan = activateGoalPlan(draft, {
      acceptanceCriteria: ["The report links exact sources"],
      killConditions: ["Owner cancels the work"],
      nonGoals: ["Send or publish the report"]
    });
    expect(plan.subtasks).toHaveLength(2);
    const firstAction = selectNextReadyGoalAction(plan, {
      completedSubtaskIds: [],
      missingAuthoritySubtaskIds: [],
      ownerDecisionSubtaskIds: []
    });
    expect(firstAction?.id).toBe(plan.subtasks[0]?.id);
    expect(assessGoalActionBudget({
      actionId: firstAction!.id,
      limits: LIMITS,
      usage: ZERO_USAGE
    }).decision).toBe("within-budget");
    const exhausted = assessGoalActionBudget({
      actionId: firstAction!.id,
      limits: LIMITS,
      usage: { ...ZERO_USAGE, attempts: LIMITS.attempts }
    });
    expect(exhausted).toMatchObject({
      decision: "terminal",
      terminal: { status: "no-progress" }
    });
    expect("success" in exhausted).toBe(false);

    const terminal = createGoalActionTerminalReceipt({
      actionId: firstAction!.id,
      blocker: "The exact source is unavailable",
      evidenceDigest: EVIDENCE_A,
      resumeCondition: "A new exact source is supplied",
      terminalKind: "blocked"
    });
    expect(assessGoalActionResume(terminal, { evidenceDigest: EVIDENCE_A })).toMatchObject({
      decision: "held",
      reason: "unchanged-evidence"
    });

    const planDigest = digest(JSON.stringify(plan));
    const pendingEffectIds = ["effect_report_draft"];
    const checkpointText = JSON.stringify(createGoalCheckpointBinding({
      pendingEffectIds,
      planDigest
    }));
    const unsupported = projectGoalProgress(plan, [
      {
        actionId: firstAction!.id,
        evidenceLink: "trace://assistant-claim",
        kind: "assistant-claim",
        schemaVersion: 1
      },
      {
        actionId: firstAction!.id,
        evidenceLink: "trace://tool-error",
        kind: "tool-error",
        schemaVersion: 1
      },
      {
        actionId: firstAction!.id,
        evidenceLink: "trace://unverifiable",
        kind: "unverifiable-output",
        schemaVersion: 1
      }
    ]);
    expect(unsupported.completedCount).toBe(0);
    expect(unsupported.completedPercentage).toBe(0);

    // Session 2: stale persisted state and changed blocker evidence only open
    // later gates. Neither decision is execution authority.
    let externalEffectExecutions = 0;
    const effectTool: MuseTool = {
      definition: {
        description: "Apply a verified report effect.",
        inputSchema: { type: "object" },
        name: "apply_report_effect",
        risk: "write"
      },
      execute: () => `applied:${(++externalEffectExecutions).toString()}`
    };
    const effectExecutor = new ToolExecutor({
      idempotencyStore: new Map(),
      registry: new ToolRegistry([effectTool])
    });
    const stale = inspectGoalCheckpointResume(checkpointText, {
      pendingEffectIds,
      planDigest: digest("changed plan")
    });
    expect(stale).toMatchObject({
      decision: "refused",
      reason: "stale-checkpoint"
    });
    expect(externalEffectExecutions).toBe(0);

    const changedEvidence = assessGoalActionResume(terminal, { evidenceDigest: EVIDENCE_B });
    expect(changedEvidence.decision).toBe("retry-ready");
    expect("executionAuthorized" in changedEvidence).toBe(false);
    expect(externalEffectExecutions).toBe(0);

    const exactResume = inspectGoalCheckpointResume(checkpointText, {
      pendingEffectIds: [...pendingEffectIds],
      planDigest
    });
    expect(exactResume.decision).toBe("resume-ready");
    expect("executionAuthorized" in exactResume).toBe(false);
    expect(externalEffectExecutions).toBe(0);

    const verifiedEffect = {
      actionId: firstAction!.id,
      effectId: "effect_report_draft",
      effectState: "applied" as const,
      evidenceLink: "artifact://report-draft",
      payloadDigest: digest("source-backed report draft"),
      schemaVersion: 1 as const,
      status: "verified-effect" as const
    };
    const verified = projectGoalProgress(plan, [verifiedEffect, verifiedEffect]);
    expect(verified.completedCount).toBe(1);
    expect(verified.completedSubtaskIds).toEqual([firstAction!.id]);
    const firstApplication = await effectExecutor.execute({
      arguments: { idempotencyKey: verifiedEffect.effectId },
      context: { runId: WORK_ID },
      id: "effect-call-1",
      name: effectTool.definition.name
    });
    const duplicateApplication = await effectExecutor.execute({
      arguments: { idempotencyKey: verifiedEffect.effectId },
      context: { runId: WORK_ID },
      id: "effect-call-2",
      name: effectTool.definition.name
    });
    expect(firstApplication.status).toBe("completed");
    expect(duplicateApplication.output).toBe(firstApplication.output);
    expect(externalEffectExecutions).toBe(1);

    const secondAction = selectNextReadyGoalAction(plan, {
      completedSubtaskIds: verified.completedSubtaskIds,
      missingAuthoritySubtaskIds: [],
      ownerDecisionSubtaskIds: []
    });
    expect(secondAction?.id).toBe(plan.subtasks[1]?.id);
  });
});
