import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createPersonalThread, linkArtifact } from "@muse/attunement";
import { writeTasks } from "@muse/stores";
import { FileProgressiveAutonomyOpportunityStore } from "@muse/stores/host-progressive-autonomy-opportunities";
import { afterEach, describe, expect, it } from "vitest";

import { ProgressiveAutonomyOpportunityReviewService } from "../src/index.js";

describe("ProgressiveAutonomyOpportunityReviewService", () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))));

  it("queues only oldest unresolved organic evidence, resolves exact source, and replays without any source or receipt rewrite", async () => {
    const fixture = await createFixture();
    await fixture.store.record(opportunity("controlled-old", "controlled", "2026-07-17T02:30:00.000Z"));
    const organic = opportunity("organic-next", "organic", "2026-07-17T03:00:00.000Z");
    await fixture.store.record(organic);
    const sourceBytes = await sourceSnapshot(fixture);

    const queued = await fixture.service.review();
    expect(queued).toMatchObject({
      currentSource: { state: "exact" },
      evidenceClass: "organic",
      linkedAt: organic.envelope.link.linkedAt,
      opportunityId: organic.id,
      taskId: organic.envelope.link.taskId,
      threadId: organic.envelope.threadId,
      toolCallId: organic.toolCallId
    });
    const recorded = await fixture.service.decide(organic.id, { decision: "would-approve", reason: "  yes  " });
    expect(recorded).toMatchObject({ decision: "would-approve", reason: "yes", sourceState: "exact" });
    const receiptBytes = await readFile(fixture.opportunitiesFile, "utf8");
    expect(await sourceSnapshot(fixture)).toEqual(sourceBytes);
    await writeFile(fixture.attunementFile, "{source became unavailable", "utf8");
    expect(await fixture.service.decide(organic.id, { decision: "would-approve", reason: "yes" })).toEqual(recorded);
    expect(await readFile(fixture.opportunitiesFile, "utf8")).toBe(receiptBytes);
    expect(await fixture.service.review()).toBeUndefined();
  });

  it("refuses stale positive and unavailable decisions without a write, but records normalized stale negative evidence", async () => {
    const stale = await createFixture();
    const organic = opportunity("organic-stale", "organic", "2026-07-17T03:00:00.000Z");
    await stale.store.record(organic);
    await writeTasks(stale.tasksFile, [{
      completedAt: "2026-07-17T03:30:00.000Z", createdAt: "2026-07-17T00:00:00.000Z",
      id: "task-next", status: "done", title: "Next"
    }]);
    const beforePositive = await readFile(stale.opportunitiesFile, "utf8");
    await expect(stale.service.decide(organic.id, { decision: "would-approve" })).rejects.toThrow("exact current source");
    expect(await readFile(stale.opportunitiesFile, "utf8")).toBe(beforePositive);
    const negative = await stale.service.decide(organic.id, { decision: "would-deny", reason: "  too late  " });
    expect(negative).toMatchObject({
      decision: "would-deny", reason: "too late",
      sourceReason: "recorded task is no longer open", sourceState: "stale"
    });

    const unavailable = await createFixture();
    const unavailableOrganic = opportunity("organic-unavailable", "organic", "2026-07-17T03:00:00.000Z");
    await unavailable.store.record(unavailableOrganic);
    await writeFile(unavailable.attunementFile, "{bad", "utf8");
    const beforeUnavailable = await readFile(unavailable.opportunitiesFile, "utf8");
    await expect(unavailable.service.decide(unavailableOrganic.id, { decision: "would-deny" }))
      .rejects.toThrow("current source is unavailable");
    expect(await readFile(unavailable.opportunitiesFile, "utf8")).toBe(beforeUnavailable);
  });

  it("treats a corrupt task source as unavailable without renaming, quarantining, or writing any decision", async () => {
    const fixture = await createFixture();
    const organic = opportunity("organic-corrupt-task", "organic", "2026-07-17T03:00:00.000Z");
    await fixture.store.record(organic);
    const corruptTaskBytes = "{corrupt tasks\n";
    await writeFile(fixture.tasksFile, corruptTaskBytes, "utf8");
    const opportunityBytes = await readFile(fixture.opportunitiesFile, "utf8");
    const namesBefore = await readdir(dirname(fixture.tasksFile));

    expect(await fixture.service.review()).toMatchObject({
      currentSource: { state: "unavailable" },
      opportunityId: organic.id
    });
    for (const decision of ["would-approve", "would-deny", "needs-adjustment"] as const) {
      await expect(fixture.service.decide(organic.id, { decision })).rejects.toThrow("current source is unavailable");
      expect(await readFile(fixture.opportunitiesFile, "utf8")).toBe(opportunityBytes);
    }
    expect(await readFile(fixture.tasksFile, "utf8")).toBe(corruptTaskBytes);
    expect(await readdir(dirname(fixture.tasksFile))).toEqual(namesBefore);
  });

  it("treats missing and permission-denied task sources as unavailable with paths and bytes unchanged", async () => {
    const missing = await createFixture();
    const missingOrganic = opportunity("organic-missing-task-source", "organic", "2026-07-17T03:00:00.000Z");
    await missing.store.record(missingOrganic);
    await rm(missing.tasksFile);
    const missingOpportunityBytes = await readFile(missing.opportunitiesFile, "utf8");
    const missingAttunementBytes = await readFile(missing.attunementFile, "utf8");
    const missingNames = await readdir(dirname(missing.tasksFile));
    expect(await missing.service.review()).toMatchObject({ currentSource: { state: "unavailable" } });
    for (const decision of ["would-approve", "would-deny", "needs-adjustment"] as const) {
      await expect(missing.service.decide(missingOrganic.id, { decision })).rejects.toThrow("current source is unavailable");
    }
    await expect(readFile(missing.tasksFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(missing.opportunitiesFile, "utf8")).toBe(missingOpportunityBytes);
    expect(await readFile(missing.attunementFile, "utf8")).toBe(missingAttunementBytes);
    expect(await readdir(dirname(missing.tasksFile))).toEqual(missingNames);

    const denied = await createFixture();
    const deniedOrganic = opportunity("organic-denied-task-source", "organic", "2026-07-17T03:00:00.000Z");
    await denied.store.record(deniedOrganic);
    const deniedTaskBytes = await readFile(denied.tasksFile, "utf8");
    const deniedOpportunityBytes = await readFile(denied.opportunitiesFile, "utf8");
    const deniedAttunementBytes = await readFile(denied.attunementFile, "utf8");
    const deniedNames = await readdir(dirname(denied.tasksFile));
    await chmod(denied.tasksFile, 0o000);
    try {
      expect(await denied.service.review()).toMatchObject({ currentSource: { state: "unavailable" } });
      for (const decision of ["would-approve", "would-deny", "needs-adjustment"] as const) {
        await expect(denied.service.decide(deniedOrganic.id, { decision })).rejects.toThrow("current source is unavailable");
      }
      expect(await readFile(denied.opportunitiesFile, "utf8")).toBe(deniedOpportunityBytes);
      expect(await readFile(denied.attunementFile, "utf8")).toBe(deniedAttunementBytes);
      expect(await readdir(dirname(denied.tasksFile))).toEqual(deniedNames);
    } finally {
      await chmod(denied.tasksFile, 0o600);
    }
    expect(await readFile(denied.tasksFile, "utf8")).toBe(deniedTaskBytes);
  });

  async function createFixture() {
    const dir = await mkdtemp(join(tmpdir(), "muse-opportunity-review-"));
    dirs.push(dir);
    const attunementFile = join(dir, "attunement.json");
    const opportunitiesFile = join(dir, "opportunities.json");
    const tasksFile = join(dir, "tasks.json");
    await writeTasks(tasksFile, [{ createdAt: "2026-07-17T00:00:00.000Z", id: "task-next", status: "open", title: "Next" }]);
    const thread = await createPersonalThread(attunementFile, { kind: "life", title: "Life" }, {
      idFactory: () => "thread-life", now: () => new Date("2026-07-17T01:00:00.000Z")
    });
    await linkArtifact(attunementFile, {
      artifactId: "task-next", artifactType: "task", role: "next-step", threadId: thread.id
    }, { now: () => new Date("2026-07-17T02:00:00.000Z"), validateArtifact: async (input) => input });
    const store = new FileProgressiveAutonomyOpportunityStore({ file: opportunitiesFile });
    return {
      attunementFile, opportunitiesFile, store, tasksFile,
      service: new ProgressiveAutonomyOpportunityReviewService({
        attunementFile, now: () => new Date("2026-07-17T04:00:00.000Z"),
        opportunitiesFile, ownerUserId: "dogfood-user", tasksFile
      })
    };
  }
});

function opportunity(id: string, evidenceClass: "controlled" | "organic", recordedAt: string) {
  const runId = `run-${id}`;
  return {
    enforcementDecision: "confirm" as const,
    envelope: {
      action: "muse.tasks.complete-linked-next-step" as const,
      idempotencyKey: `runtime-opportunity:${runId}:task-next`,
      link: { artifactType: "task" as const, linkedAt: "2026-07-17T02:00:00.000Z", providerId: "local" as const, role: "next-step" as const, taskId: "task-next" },
      schemaVersion: 1 as const, threadId: "thread_thread-life", traceId: `runtime-tool:${runId}:call-1`,
      transition: { from: "open" as const, to: "done" as const }, userId: "dogfood-user"
    },
    evidenceClass, id, origin: "runtime-opportunity" as const, rationale: "confirm", recordedAt, runId,
    shadowAssessment: "wouldConfirm" as const, shadowRationale: "no exact active standing grant", toolCallId: "call-1"
  };
}

async function sourceSnapshot(fixture: { attunementFile: string; tasksFile: string }) {
  return Promise.all([readFile(fixture.attunementFile, "utf8"), readFile(fixture.tasksFile, "utf8")]);
}
