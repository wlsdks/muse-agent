import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPersonalThread, linkArtifact, unlinkArtifact } from "@muse/attunement";
import { writeTasks } from "@muse/stores";
import { FileProgressiveAutonomyOpportunityStore } from "@muse/stores/host-progressive-autonomy-opportunities";
import { afterEach, describe, expect, it } from "vitest";

import {
  createProgressiveAutonomyRuntimeDecisionRecorder,
  ProgressiveAutonomyOpportunityReviewService
} from "../src/index.js";

describe("createProgressiveAutonomyRuntimeDecisionRecorder", () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))));

  it("submits only explicit decision identity and lets the store bind the persisted scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-runtime-decision-recorder-"));
    dirs.push(dir);
    const attunementFile = join(dir, "attunement.json");
    const opportunitiesFile = join(dir, "opportunities.json");
    const tasksFile = join(dir, "tasks.json");
    await writeTasks(tasksFile, [{ createdAt: "2026-07-17T00:00:00.000Z", id: "task-next", status: "open", title: "Next" }]);
    const thread = await createPersonalThread(attunementFile, { kind: "life", title: "Life" }, {
      idFactory: () => "life",
      now: () => new Date("2026-07-17T01:00:00.000Z")
    });
    const linked = await linkArtifact(attunementFile, {
      artifactId: "task-next", artifactType: "task", role: "next-step", threadId: thread.id
    }, { now: () => new Date("2026-07-17T02:00:00.000Z"), validateArtifact: async (input) => input });
    const store = new FileProgressiveAutonomyOpportunityStore({ file: opportunitiesFile });
    const opportunity = organicOpportunity({ linkedAt: linked.link.linkedAt, threadId: thread.id });
    await store.record(opportunity);
    const record = createProgressiveAutonomyRuntimeDecisionRecorder({
      attunementFile,
      opportunitiesFile,
      ownerUserId: opportunity.envelope.userId,
      tasksFile
    });

    await record({
      decision: "approved",
      ownerUserId: opportunity.envelope.userId,
      recordedAt: "2026-07-17T04:00:00.000Z",
      runId: opportunity.runId,
      toolCallId: opportunity.toolCallId
    });

    expect(await store.listRuntimeDecisions()).toMatchObject([{
      decision: "approved",
      opportunityId: opportunity.id,
      taskId: opportunity.envelope.link.taskId,
      toolName: "muse.tasks.complete"
    }]);
  });

  it("does not record after the exact task is unlinked and re-linked at a different time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-runtime-decision-recorder-"));
    dirs.push(dir);
    const attunementFile = join(dir, "attunement.json");
    const opportunitiesFile = join(dir, "opportunities.json");
    const tasksFile = join(dir, "tasks.json");
    await writeTasks(tasksFile, [{ createdAt: "2026-07-17T00:00:00.000Z", id: "task-next", status: "open", title: "Next" }]);
    const thread = await createPersonalThread(attunementFile, { kind: "life", title: "Life" }, {
      idFactory: () => "life",
      now: () => new Date("2026-07-17T01:00:00.000Z")
    });
    const linked = await linkArtifact(attunementFile, {
      artifactId: "task-next", artifactType: "task", role: "next-step", threadId: thread.id
    }, { now: () => new Date("2026-07-17T02:00:00.000Z"), validateArtifact: async (input) => input });
    const opportunity = organicOpportunity({ linkedAt: linked.link.linkedAt, threadId: thread.id });
    const store = new FileProgressiveAutonomyOpportunityStore({ file: opportunitiesFile });
    await store.record(opportunity);
    await unlinkArtifact(attunementFile, { artifactId: "task-next", artifactType: "task", threadId: thread.id });
    await linkArtifact(attunementFile, {
      artifactId: "task-next", artifactType: "task", role: "next-step", threadId: thread.id
    }, { now: () => new Date("2026-07-17T03:30:00.000Z"), validateArtifact: async (input) => input });
    const record = createProgressiveAutonomyRuntimeDecisionRecorder({
      attunementFile,
      opportunitiesFile,
      ownerUserId: opportunity.envelope.userId,
      tasksFile
    });

    expect(await record({
      decision: "approved",
      ownerUserId: opportunity.envelope.userId,
      recordedAt: "2026-07-17T04:00:00.000Z",
      runId: opportunity.runId,
      toolCallId: opportunity.toolCallId
    })).toEqual({ kind: "not-correlated" });
    expect(await store.listRuntimeDecisions()).toEqual([]);
    expect(await new ProgressiveAutonomyOpportunityReviewService({
      attunementFile,
      opportunitiesFile,
      ownerUserId: opportunity.envelope.userId,
      tasksFile
    }).review()).toMatchObject({ opportunityId: opportunity.id });
  });

  it("does not record when the linked task or current source is changed, missing, or closed", async () => {
    const cases = [
      {
        mutate: async (fixture: CurrentSourceFixture) => {
          await unlinkArtifact(fixture.attunementFile, {
            artifactId: "task-next", artifactType: "task", threadId: fixture.threadId
          });
          await writeTasks(fixture.tasksFile, [
            { createdAt: "2026-07-17T00:00:00.000Z", id: "task-next", status: "open", title: "Next" },
            { createdAt: "2026-07-17T00:00:00.000Z", id: "task-other", status: "open", title: "Other" }
          ]);
          await linkArtifact(fixture.attunementFile, {
            artifactId: "task-other", artifactType: "task", role: "next-step", threadId: fixture.threadId
          }, { now: () => new Date("2026-07-17T03:30:00.000Z"), validateArtifact: async (input) => input });
        },
        name: "different linked task"
      },
      {
        mutate: async (fixture: CurrentSourceFixture) => { await writeTasks(fixture.tasksFile, []); },
        name: "missing recorded task"
      },
      {
        mutate: async (fixture: CurrentSourceFixture) => {
          await writeTasks(fixture.tasksFile, [{
            completedAt: "2026-07-17T03:30:00.000Z",
            createdAt: "2026-07-17T00:00:00.000Z",
            id: "task-next",
            status: "done",
            title: "Next"
          }]);
        },
        name: "closed recorded task"
      },
      {
        mutate: async (fixture: CurrentSourceFixture) => { await rm(fixture.tasksFile); },
        name: "missing task source"
      },
      {
        mutate: async (fixture: CurrentSourceFixture) => { await rm(fixture.attunementFile); },
        name: "missing attunement source"
      }
    ];
    for (const testCase of cases) {
      const fixture = await createCurrentSourceFixture();
      dirs.push(fixture.dir);
      await testCase.mutate(fixture);

      expect(await fixture.record({
        decision: "approved",
        ownerUserId: fixture.opportunity.envelope.userId,
        recordedAt: "2026-07-17T04:00:00.000Z",
        runId: fixture.opportunity.runId,
        toolCallId: fixture.opportunity.toolCallId
      }), testCase.name).toEqual({ kind: "not-correlated" });
      expect(await fixture.store.listRuntimeDecisions(), testCase.name).toEqual([]);
      expect(await fixture.review.review(), testCase.name).toMatchObject({ opportunityId: fixture.opportunity.id });
    }
  });

  it("fails soft and preserves corrupt evidence bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-runtime-decision-recorder-"));
    dirs.push(dir);
    const opportunitiesFile = join(dir, "opportunities.json");
    const corruptBytes = "{corrupt evidence\n";
    await writeFile(opportunitiesFile, corruptBytes, "utf8");
    const record = createProgressiveAutonomyRuntimeDecisionRecorder({
      attunementFile: join(dir, "attunement.json"),
      opportunitiesFile,
      ownerUserId: "dogfood-user",
      tasksFile: join(dir, "tasks.json")
    });

    await expect(record({
      decision: "denied",
      ownerUserId: "dogfood-user",
      recordedAt: "2026-07-17T04:00:00.000Z",
      runId: "run-1",
      toolCallId: "call-1"
    })).resolves.toBeUndefined();
    expect(await readFile(opportunitiesFile, "utf8")).toBe(corruptBytes);
  });
});

function organicOpportunity(overrides: { readonly linkedAt?: string; readonly threadId?: string } = {}) {
  return {
    enforcementDecision: "confirm" as const,
    envelope: {
      action: "muse.tasks.complete-linked-next-step" as const,
      idempotencyKey: "runtime-opportunity:run-1:task-next",
      link: { artifactType: "task" as const, linkedAt: overrides.linkedAt ?? "2026-07-17T02:00:00.000Z", providerId: "local" as const, role: "next-step" as const, taskId: "task-next" },
      schemaVersion: 1 as const,
      threadId: overrides.threadId ?? "thread-life",
      traceId: "runtime-tool:run-1:call-1",
      transition: { from: "open" as const, to: "done" as const },
      userId: "dogfood-user"
    },
    evidenceClass: "organic" as const,
    id: "opportunity-1",
    origin: "runtime-opportunity" as const,
    rationale: "confirm",
    recordedAt: "2026-07-17T03:00:00.000Z",
    runId: "run-1",
    shadowAssessment: "wouldConfirm" as const,
    shadowRationale: "confirm",
    toolCallId: "call-1"
  };
}

interface CurrentSourceFixture {
  readonly attunementFile: string;
  readonly dir: string;
  readonly opportunity: ReturnType<typeof organicOpportunity>;
  readonly record: ReturnType<typeof createProgressiveAutonomyRuntimeDecisionRecorder>;
  readonly review: ProgressiveAutonomyOpportunityReviewService;
  readonly store: FileProgressiveAutonomyOpportunityStore;
  readonly tasksFile: string;
  readonly threadId: string;
}

async function createCurrentSourceFixture(): Promise<CurrentSourceFixture> {
  const dir = await mkdtemp(join(tmpdir(), "muse-runtime-decision-recorder-"));
  const attunementFile = join(dir, "attunement.json");
  const opportunitiesFile = join(dir, "opportunities.json");
  const tasksFile = join(dir, "tasks.json");
  await writeTasks(tasksFile, [{ createdAt: "2026-07-17T00:00:00.000Z", id: "task-next", status: "open", title: "Next" }]);
  const thread = await createPersonalThread(attunementFile, { kind: "life", title: "Life" }, {
    idFactory: () => "life",
    now: () => new Date("2026-07-17T01:00:00.000Z")
  });
  const linked = await linkArtifact(attunementFile, {
    artifactId: "task-next", artifactType: "task", role: "next-step", threadId: thread.id
  }, { now: () => new Date("2026-07-17T02:00:00.000Z"), validateArtifact: async (input) => input });
  const opportunity = organicOpportunity({ linkedAt: linked.link.linkedAt, threadId: thread.id });
  const store = new FileProgressiveAutonomyOpportunityStore({ file: opportunitiesFile });
  await store.record(opportunity);
  return {
    attunementFile,
    dir,
    opportunity,
    record: createProgressiveAutonomyRuntimeDecisionRecorder({
      attunementFile, opportunitiesFile, ownerUserId: opportunity.envelope.userId, tasksFile
    }),
    review: new ProgressiveAutonomyOpportunityReviewService({
      attunementFile, opportunitiesFile, ownerUserId: opportunity.envelope.userId, tasksFile
    }),
    store,
    tasksFile,
    threadId: thread.id
  };
}
