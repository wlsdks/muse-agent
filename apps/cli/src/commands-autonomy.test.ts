import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPersonalThread, linkArtifact, unlinkArtifact } from "@muse/attunement";
import { readTasks, writeTasks } from "@muse/stores";
import { FileProgressiveAutonomyOpportunityStore } from "@muse/stores/host-progressive-autonomy-opportunities";
import { afterEach, describe, expect, it } from "vitest";

import { createProgram, type ProgramIO } from "./program.js";
import { buildShadowReport } from "./commands-autonomy.js";

describe("muse autonomy trusted shadow CLI", () => {
  const dirs: string[] = [];
  const originalEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...originalEnv };
    process.exitCode = 0;
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("classifies legacy runtime evidence as unclassified and never counts 22 manual receipts toward v3 readiness", () => {
    const envelope = {
      action: "muse.tasks.complete-linked-next-step",
      idempotencyKey: "runtime-opportunity:run-1:task-next",
      link: { artifactType: "task", linkedAt: "2026-07-17T02:00:00.000Z", providerId: "local", role: "next-step", taskId: "task-next" },
      schemaVersion: 1,
      threadId: "thread-life",
      traceId: "runtime-tool:run-1:call-1",
      transition: { from: "open", to: "done" },
      userId: "dogfood-user"
    } as const;
    const manual = Array.from({ length: 22 }, (_, index) => ({
      enforcementDecision: "confirm" as const,
      envelope,
      executionId: `manual-${index.toString()}`,
      grantId: "grant-1",
      id: `receipt-${index.toString()}`,
      rationale: "explicit confirmation required",
      recordedAt: "2026-07-17T03:00:00.000Z",
      shadowAssessment: "wouldConfirm" as const,
      shadowRationale: "no exact active standing grant"
    }));
    const runtime = {
      enforcementDecision: "confirm" as const,
      envelope,
      evidenceClass: "unclassified" as const,
      id: "runtime-1",
      origin: "runtime-opportunity" as const,
      rationale: "explicit confirmation required",
      recordedAt: "2026-07-17T03:00:00.000Z",
      runId: "run-1",
      shadowAssessment: "wouldConfirm" as const,
      shadowRationale: "no exact active standing grant",
      toolCallId: "call-1"
    };

    const report = buildShadowReport(manual, [runtime, { ...runtime, id: "runtime-2", toolCallId: "call-2" }]);

    expect(report.sources.manualCli.observedDecisions).toBe(22);
    expect(report.schemaVersion).toBe(3);
    expect(report.sources.runtimeOpportunity).toMatchObject({
      byEvidenceClass: { controlled: 0, organic: 0, unclassified: 1 },
      observedDecisions: 1
    });
    expect(report.review).toMatchObject({
      eligibleReviews: 0,
      remainingReviews: 20,
      status: "collecting",
      unresolvedOrganicOpportunities: 0
    });
  });

  it("requires audit at twenty unique organic reviews and never reports ready or promoted authority", () => {
    const opportunities = Array.from({ length: 20 }, (_, index) => {
      const suffix = index.toString();
      const runId = `run-${suffix}`;
      return {
        enforcementDecision: "confirm" as const,
        envelope: {
          action: "muse.tasks.complete-linked-next-step" as const,
          idempotencyKey: `runtime-opportunity:${runId}:task-${suffix}`,
          link: { artifactType: "task" as const, linkedAt: "2026-07-17T02:00:00.000Z", providerId: "local" as const, role: "next-step" as const, taskId: `task-${suffix}` },
          schemaVersion: 1 as const, threadId: `thread-${suffix}`, traceId: `runtime-tool:${runId}:call-1`,
          transition: { from: "open" as const, to: "done" as const }, userId: "dogfood-user"
        },
        evidenceClass: "organic" as const, id: `opportunity-${suffix}`, origin: "runtime-opportunity" as const,
        rationale: "confirm", recordedAt: `2026-07-${(index + 1).toString().padStart(2, "0")}T03:00:00.000Z`,
        runId, shadowAssessment: "wouldConfirm" as const, shadowRationale: "confirm", toolCallId: "call-1"
      };
    });
    const reviews = opportunities.map((opportunity, index) => ({
      action: opportunity.envelope.action,
      decision: index % 2 === 0 ? "would-approve" as const : "would-deny" as const,
      evidenceClass: "organic" as const, id: `review-${index.toString()}`,
      linkedAt: opportunity.envelope.link.linkedAt, opportunityId: opportunity.id,
      ownerUserId: opportunity.envelope.userId, recordedAt: `2026-07-${(index + 1).toString().padStart(2, "0")}T04:00:00.000Z`,
      runId: opportunity.runId, sourceState: "exact" as const, taskId: opportunity.envelope.link.taskId,
      threadId: opportunity.envelope.threadId, toolCallId: opportunity.toolCallId
    }));

    const report = buildShadowReport([], opportunities, reviews);
    expect(report.review).toMatchObject({
      decisionDistribution: { "needs-adjustment": 0, "would-approve": 10, "would-deny": 10 },
      eligibleReviews: 20, remainingReviews: 0, status: "audit-required"
    });
    expect(JSON.stringify(report)).not.toMatch(/ready|allowed|promoted/u);
  });

  it("defensively excludes an impossible stale would-approve review from v3 eligibility", () => {
    const opportunity = {
      enforcementDecision: "confirm" as const,
      envelope: {
        action: "muse.tasks.complete-linked-next-step" as const,
        idempotencyKey: "runtime-opportunity:run-invalid:task-next",
        link: { artifactType: "task" as const, linkedAt: "2026-07-17T02:00:00.000Z", providerId: "local" as const, role: "next-step" as const, taskId: "task-next" },
        schemaVersion: 1 as const, threadId: "thread-life", traceId: "runtime-tool:run-invalid:call-1",
        transition: { from: "open" as const, to: "done" as const }, userId: "dogfood-user"
      },
      evidenceClass: "organic" as const, id: "opportunity-invalid", origin: "runtime-opportunity" as const,
      rationale: "confirm", recordedAt: "2026-07-17T03:00:00.000Z", runId: "run-invalid",
      shadowAssessment: "wouldConfirm" as const, shadowRationale: "confirm", toolCallId: "call-1"
    };
    const report = buildShadowReport([], [opportunity], [{
      action: opportunity.envelope.action,
      decision: "would-approve",
      evidenceClass: "organic",
      id: "review-invalid",
      linkedAt: opportunity.envelope.link.linkedAt,
      opportunityId: opportunity.id,
      ownerUserId: opportunity.envelope.userId,
      recordedAt: "2026-07-17T04:00:00.000Z",
      runId: opportunity.runId,
      sourceReason: "recorded task is no longer open",
      sourceState: "stale",
      taskId: opportunity.envelope.link.taskId,
      threadId: opportunity.envelope.threadId,
      toolCallId: opportunity.toolCallId
    }]);

    expect(report.review).toMatchObject({ eligibleReviews: 0, remainingReviews: 20, unresolvedOrganicOpportunities: 1 });
    expect(report.review.decisionDistribution["would-approve"]).toBe(0);
  });

  it("grants the exact open user-linked local next step through the public program", async () => {
    const fixture = await createFixture();
    const { errors, output } = await run(["grant-next-step", fixture.threadId, "--json"]);

    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      action: "muse.tasks.complete-linked-next-step",
      link: { providerId: "local", role: "next-step", taskId: fixture.taskId },
      maxUses: 20,
      threadId: fixture.threadId,
      userId: "dogfood-user"
    });
    expect(await readTasks(fixture.tasksFile)).toMatchObject([{ id: fixture.taskId, status: "open" }]);
  });

  it("lists durable grants through stable JSON", async () => {
    const fixture = await createFixture();
    const granted = await run(["grant-next-step", fixture.threadId, "--json"]);
    const grant = JSON.parse(granted.output.join("")) as { readonly id: string };

    const listed = await run(["list", "--json"]);

    expect(listed.errors).toEqual([]);
    expect(JSON.parse(listed.output.join(""))).toEqual({
      grants: [{ grant: expect.objectContaining({ id: grant.id }), usedCount: 0 }],
      schemaVersion: 1
    });
  });

  it("revokes an exact grant through the trusted CLI invocation", async () => {
    const fixture = await createFixture();
    const granted = await run(["grant-next-step", fixture.threadId, "--json"]);
    const grant = JSON.parse(granted.output.join("")) as { readonly id: string };

    const revoked = await run(["revoke", grant.id, "--json"]);

    expect(revoked.errors).toEqual([]);
    expect(JSON.parse(revoked.output.join(""))).toMatchObject({
      grant: { id: grant.id },
      revokedAt: expect.any(String),
      usedCount: 0
    });
    const listed = await run(["list", "--json"]);
    expect(JSON.parse(listed.output.join(""))).toMatchObject({
      grants: [{ grant: { id: grant.id }, revokedAt: expect.any(String), usedCount: 0 }]
    });
    const taskBytes = await readFile(fixture.tasksFile, "utf8");
    const shadowed = await run(["shadow", grant.id, "--json"]);
    expect(JSON.parse(shadowed.output.join(""))).toMatchObject({ shadowAssessment: "wouldConfirm" });
    expect(await readFile(fixture.tasksFile, "utf8")).toBe(taskBytes);
  });

  it("records one durable shadow decision without changing task bytes or grant use count", async () => {
    const fixture = await createFixture();
    const granted = await run(["grant-next-step", fixture.threadId, "--json"]);
    const grant = JSON.parse(granted.output.join("")) as { readonly id: string };
    const taskBytes = await readFile(fixture.tasksFile, "utf8");

    const shadowed = await run(["shadow", grant.id, "--json"]);

    expect(shadowed.errors).toEqual([]);
    expect(JSON.parse(shadowed.output.join(""))).toMatchObject({
      enforcementDecision: "confirm",
      grantId: grant.id,
      shadowAssessment: "wouldAllowStanding"
    });
    expect(await readFile(fixture.tasksFile, "utf8")).toBe(taskBytes);
    const listed = await run(["list", "--json"]);
    expect(JSON.parse(listed.output.join(""))).toMatchObject({ grants: [{ usedCount: 0 }] });
  });

  it("reports only durable shadow decisions with stable review semantics", async () => {
    const fixture = await createFixture();
    const granted = await run(["grant-next-step", fixture.threadId, "--json"]);
    const grant = JSON.parse(granted.output.join("")) as { readonly id: string };
    await run(["shadow", grant.id, "--json"]);

    const reported = await run(["report", "--json"]);

    expect(reported.errors).toEqual([]);
    expect(JSON.parse(reported.output.join(""))).toEqual({
      review: {
        coverage: 0,
        decisionDistribution: { "needs-adjustment": 0, "would-approve": 0, "would-deny": 0 },
        eligibleReviews: 0,
        minimumEligibleReviews: 20,
        promotion: "explicit-user-decision-only",
        remainingReviews: 20,
        status: "collecting",
        targetEligibleReviews: 50,
        unique: { days: 0, tasks: 0, threads: 0 },
        unresolvedOrganicOpportunities: 0
      },
      schemaVersion: 3,
      sources: {
        manualCli: {
          assessments: { wouldAllowStanding: 1, wouldConfirm: 0, wouldDeny: 0 },
          classification: "legacy-read-only",
          observedDecisions: 1,
          rationales: [{ count: 1, rationale: "exact active standing grant" }],
          unique: { days: 1, tasks: 1, threads: 1 }
        },
        organicReview: {
          classification: "explicit-counterfactual-user-review",
          decisions: { "needs-adjustment": 0, "would-approve": 0, "would-deny": 0 },
          observedDecisions: 0,
          unique: { days: 0, tasks: 0, threads: 0 }
        },
        runtimeOpportunity: {
          assessments: { wouldAllowStanding: 0, wouldConfirm: 0, wouldDeny: 0 },
          byEvidenceClass: { controlled: 0, organic: 0, unclassified: 0 },
          classification: "runtime-opportunity-by-provenance",
          excludedFromReadiness: 0,
          observedDecisions: 0,
          rationales: [],
          unique: { days: 0, tasks: 0, threads: 0 }
        }
      }
    });
  });

  it("reviews and decides one organic opportunity through the public CLI without mutating task, thread, or authority bytes", async () => {
    const fixture = await createFixture();
    const opportunity = await new FileProgressiveAutonomyOpportunityStore({ file: fixture.opportunitiesFile }).record({
      enforcementDecision: "confirm",
      envelope: {
        action: "muse.tasks.complete-linked-next-step",
        idempotencyKey: `runtime-opportunity:run-cli:${fixture.taskId}`,
        link: { artifactType: "task", linkedAt: "2026-07-17T02:00:00.000Z", providerId: "local", role: "next-step", taskId: fixture.taskId },
        schemaVersion: 1, threadId: fixture.threadId, traceId: "runtime-tool:run-cli:call-1",
        transition: { from: "open", to: "done" }, userId: "dogfood-user"
      },
      evidenceClass: "organic",
      id: "organic-cli", origin: "runtime-opportunity", rationale: "confirm",
      recordedAt: "2026-07-17T03:00:00.000Z", runId: "run-cli",
      shadowAssessment: "wouldConfirm", shadowRationale: "no exact active standing grant", toolCallId: "call-1"
    });
    const sourceBytes = await Promise.all([
      readFile(fixture.tasksFile, "utf8"), readFile(fixture.attunementFile, "utf8")
    ]);

    const reviewed = await run(["review", "--json"]);
    expect(reviewed.errors).toEqual([]);
    expect(JSON.parse(reviewed.output.join(""))).toMatchObject({ opportunity: { opportunityId: opportunity.id, currentSource: { state: "exact" } } });
    const decided = await run(["decide", opportunity.id, "--decision", "would-approve", "--reason", "  yes  ", "--json"]);
    expect(decided.errors).toEqual([]);
    expect(JSON.parse(decided.output.join(""))).toMatchObject({ decision: "would-approve", reason: "yes" });
    const report = JSON.parse((await run(["report", "--json"])).output.join("")) as Record<string, unknown>;
    expect(report).toMatchObject({
      review: {
        coverage: 1,
        decisionDistribution: { "needs-adjustment": 0, "would-approve": 1, "would-deny": 0 },
        eligibleReviews: 1,
        unresolvedOrganicOpportunities: 0
      }
    });
    expect(await Promise.all([
      readFile(fixture.tasksFile, "utf8"), readFile(fixture.attunementFile, "utf8")
    ])).toEqual(sourceBytes);
    await expect(readFile(fixture.autonomyFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on corrupt autonomy persistence without overwriting it", async () => {
    const fixture = await createFixture();
    const corrupt = "{not valid progressive autonomy json\n";
    await writeFile(fixture.autonomyFile, corrupt, "utf8");

    const listed = await run(["list", "--json"]);

    expect(listed.errors.join("")).toContain("store is corrupt");
    expect(process.exitCode).toBe(2);
    expect(await readFile(fixture.autonomyFile, "utf8")).toBe(corrupt);
  });

  it("fails the v2 report on corrupt runtime opportunity persistence without overwriting it", async () => {
    const fixture = await createFixture();
    const corrupt = JSON.stringify({ opportunities: [], schemaVersion: 999, traces: [] });
    await writeFile(fixture.opportunitiesFile, corrupt, "utf8");

    const reported = await run(["report", "--json"]);

    expect(reported.errors.join("")).toContain("opportunity store is corrupt");
    expect(process.exitCode).toBe(2);
    expect(await readFile(fixture.opportunitiesFile, "utf8")).toBe(corrupt);
  });

  it("fails the v3 report on persisted stale would-approve corruption without overwriting evidence", async () => {
    const fixture = await createFixture();
    const opportunity = await new FileProgressiveAutonomyOpportunityStore({ file: fixture.opportunitiesFile }).record({
      enforcementDecision: "confirm",
      envelope: {
        action: "muse.tasks.complete-linked-next-step",
        idempotencyKey: `runtime-opportunity:run-stale-approve:${fixture.taskId}`,
        link: { artifactType: "task", linkedAt: "2026-07-17T02:00:00.000Z", providerId: "local", role: "next-step", taskId: fixture.taskId },
        schemaVersion: 1, threadId: fixture.threadId, traceId: "runtime-tool:run-stale-approve:call-1",
        transition: { from: "open", to: "done" }, userId: "dogfood-user"
      },
      evidenceClass: "organic",
      id: "opportunity-stale-approve",
      origin: "runtime-opportunity",
      rationale: "confirm",
      recordedAt: "2026-07-17T03:00:00.000Z",
      runId: "run-stale-approve",
      shadowAssessment: "wouldConfirm",
      shadowRationale: "confirm",
      toolCallId: "call-1"
    });
    const state = JSON.parse(await readFile(fixture.opportunitiesFile, "utf8")) as { reviews: unknown[] };
    state.reviews.push({
      action: opportunity.envelope.action,
      decision: "would-approve",
      evidenceClass: "organic",
      id: "review-stale-approve",
      linkedAt: opportunity.envelope.link.linkedAt,
      opportunityId: opportunity.id,
      ownerUserId: opportunity.envelope.userId,
      recordedAt: "2026-07-17T04:00:00.000Z",
      runId: opportunity.runId,
      sourceReason: "recorded task is no longer open",
      sourceState: "stale",
      taskId: opportunity.envelope.link.taskId,
      threadId: opportunity.envelope.threadId,
      toolCallId: opportunity.toolCallId
    });
    const corruptBytes = JSON.stringify(state);
    await writeFile(fixture.opportunitiesFile, corruptBytes, "utf8");

    const reported = await run(["report", "--json"]);
    expect(reported.errors.join("")).toContain("opportunity store is corrupt");
    expect(process.exitCode).toBe(2);
    expect(await readFile(fixture.opportunitiesFile, "utf8")).toBe(corruptBytes);
  });

  it("reports a schema-v1 runtime receipt as unclassified without rewriting its bytes", async () => {
    const fixture = await createFixture();
    const envelope = {
      action: "muse.tasks.complete-linked-next-step" as const,
      idempotencyKey: `runtime-opportunity:legacy-run:${fixture.taskId}`,
      link: { artifactType: "task" as const, linkedAt: "2026-07-17T11:00:00+09:00", providerId: "local" as const, role: "next-step" as const, taskId: fixture.taskId },
      schemaVersion: 1 as const, threadId: fixture.threadId, traceId: "runtime-tool:legacy-run:call-1",
      transition: { from: "open" as const, to: "done" as const }, userId: "dogfood-user"
    };
    const receipt = {
      enforcementDecision: "confirm", envelope, id: "legacy-opportunity", origin: "runtime-opportunity",
      rationale: "confirm", recordedAt: "2026-07-17T12:00:00+09:00", runId: "legacy-run",
      shadowAssessment: "wouldConfirm", shadowRationale: "confirm", toolCallId: "call-1"
    };
    const legacyBytes = `${JSON.stringify({
      opportunities: [receipt], schemaVersion: 1,
      traces: [{ envelope, runId: "legacy-run", toolCallId: "call-1" }]
    }, null, 2)}\n`;
    await writeFile(fixture.opportunitiesFile, legacyBytes, "utf8");

    const reported = await run(["report", "--json"]);
    expect(reported.errors).toEqual([]);
    expect(JSON.parse(reported.output.join(""))).toMatchObject({
      review: { eligibleReviews: 0, remainingReviews: 20, status: "collecting" },
      sources: { runtimeOpportunity: { byEvidenceClass: { controlled: 0, organic: 0, unclassified: 1 } } }
    });
    expect(await readFile(fixture.opportunitiesFile, "utf8")).toBe(legacyBytes);
  });

  it("fails the v2 report on a canonical-trace identity mismatch without overwriting evidence", async () => {
    const fixture = await createFixture();
    const envelope = {
      action: "muse.tasks.complete-linked-next-step" as const,
      idempotencyKey: `runtime-opportunity:run-report:${fixture.taskId}`,
      link: {
        artifactType: "task" as const,
        linkedAt: "2026-07-17T02:00:00.000Z",
        providerId: "local" as const,
        role: "next-step" as const,
        taskId: fixture.taskId
      },
      schemaVersion: 1 as const,
      threadId: fixture.threadId,
      traceId: "runtime-tool:run-report:call-1",
      transition: { from: "open" as const, to: "done" as const },
      userId: "dogfood-user"
    };
    await new FileProgressiveAutonomyOpportunityStore({ file: fixture.opportunitiesFile }).record({
      enforcementDecision: "confirm",
      envelope,
      evidenceClass: "unclassified",
      id: "runtime-report-1",
      origin: "runtime-opportunity",
      rationale: "explicit confirmation required",
      recordedAt: "2026-07-17T03:00:00.000Z",
      runId: "run-report",
      shadowAssessment: "wouldConfirm",
      shadowRationale: "no exact active standing grant",
      toolCallId: "call-1"
    });
    const state = JSON.parse(await readFile(fixture.opportunitiesFile, "utf8")) as {
      traces: Array<{ envelope: { traceId: string }; toolCallId: string }>;
    };
    state.traces[0]!.toolCallId = "call-2";
    state.traces[0]!.envelope.traceId = "runtime-tool:run-report:call-2";
    const corrupt = JSON.stringify(state);
    await writeFile(fixture.opportunitiesFile, corrupt, "utf8");

    const reported = await run(["report", "--json"]);

    expect(reported.errors.join("")).toContain("opportunity store is corrupt");
    expect(process.exitCode).toBe(2);
    expect(await readFile(fixture.opportunitiesFile, "utf8")).toBe(corrupt);
  });

  it("records wouldDeny after unlink-relink without mutating the task or consuming a use", async () => {
    const fixture = await createFixture();
    const granted = await run(["grant-next-step", fixture.threadId, "--json"]);
    const grant = JSON.parse(granted.output.join("")) as { readonly id: string };
    await unlinkArtifact(fixture.attunementFile, {
      artifactId: fixture.taskId,
      artifactType: "task",
      threadId: fixture.threadId
    });
    await linkArtifact(fixture.attunementFile, {
      artifactId: fixture.taskId,
      artifactType: "task",
      role: "next-step",
      threadId: fixture.threadId
    }, {
      now: () => new Date("2026-07-17T03:00:00.000Z"),
      validateArtifact: async (input) => input
    });
    const taskBytes = await readFile(fixture.tasksFile, "utf8");

    const shadowed = await run(["shadow", grant.id, "--json"]);

    expect(shadowed.errors).toEqual([]);
    expect(JSON.parse(shadowed.output.join(""))).toMatchObject({ shadowAssessment: "wouldDeny" });
    expect(await readFile(fixture.tasksFile, "utf8")).toBe(taskBytes);
    const listed = await run(["list", "--json"]);
    expect(JSON.parse(listed.output.join(""))).toMatchObject({ grants: [{ usedCount: 0 }] });
  });

  it("rejects an unknown grant without writing evidence or touching tasks", async () => {
    const fixture = await createFixture();
    await run(["grant-next-step", fixture.threadId, "--json"]);
    const autonomyBytes = await readFile(fixture.autonomyFile, "utf8");
    const taskBytes = await readFile(fixture.tasksFile, "utf8");

    const shadowed = await run(["shadow", "missing-grant", "--json"]);

    expect(shadowed.errors.join("")).toContain("does not exist");
    expect(process.exitCode).toBe(2);
    expect(await readFile(fixture.autonomyFile, "utf8")).toBe(autonomyBytes);
    expect(await readFile(fixture.tasksFile, "utf8")).toBe(taskBytes);
  });

  it("rejects a closed linked task without evidence, task mutation, or use consumption", async () => {
    const fixture = await createFixture();
    const granted = await run(["grant-next-step", fixture.threadId, "--json"]);
    const grant = JSON.parse(granted.output.join("")) as { readonly id: string };
    const tasks = await readTasks(fixture.tasksFile);
    await writeTasks(fixture.tasksFile, tasks.map((task) => task.id === fixture.taskId
      ? { ...task, completedAt: "2026-07-17T04:00:00.000Z", status: "done" }
      : task));
    const autonomyBytes = await readFile(fixture.autonomyFile, "utf8");
    const taskBytes = await readFile(fixture.tasksFile, "utf8");

    const shadowed = await run(["shadow", grant.id, "--json"]);

    expect(shadowed.errors.join("")).toContain("not open");
    expect(await readFile(fixture.autonomyFile, "utf8")).toBe(autonomyBytes);
    expect(await readFile(fixture.tasksFile, "utf8")).toBe(taskBytes);
    const listed = await run(["list", "--json"]);
    expect(JSON.parse(listed.output.join(""))).toMatchObject({ grants: [{ usedCount: 0 }] });
  });

  it("rejects grant bounds outside the fixed CLI contract before creating authority", async () => {
    const fixture = await createFixture();

    const invalidUses = await run(["grant-next-step", fixture.threadId, "--max-uses", "51", "--json"]);

    expect(invalidUses.errors.join("")).toContain("max-uses must be an integer from 1 to 50");
    await expect(readFile(fixture.autonomyFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs grant to shadow to report to revoke under an isolated default HOME", async () => {
    const fixture = await createFixture({ defaultHomePaths: true });
    const taskBytes = await readFile(fixture.tasksFile, "utf8");

    const granted = await run(["grant-next-step", fixture.threadId, "--json"]);
    const grant = JSON.parse(granted.output.join("")) as { readonly id: string };
    await run(["shadow", grant.id, "--json"]);
    const reported = await run(["report", "--json"]);
    const revoked = await run(["revoke", grant.id, "--json"]);

    expect(JSON.parse(reported.output.join(""))).toMatchObject({
      review: { eligibleReviews: 0 },
      sources: { manualCli: { observedDecisions: 1 } }
    });
    expect(JSON.parse(revoked.output.join(""))).toMatchObject({ revokedAt: expect.any(String), usedCount: 0 });
    expect(await readFile(fixture.tasksFile, "utf8")).toBe(taskBytes);
    expect(fixture.autonomyFile).toContain(join(".muse", "progressive-autonomy.json"));
  });

  it("records wouldConfirm for an expired existing grant without mutation or use consumption", async () => {
    const fixture = await createFixture();
    const granted = await run(["grant-next-step", fixture.threadId, "--json"]);
    const grant = JSON.parse(granted.output.join("")) as { readonly id: string };
    const state = JSON.parse(await readFile(fixture.autonomyFile, "utf8")) as {
      grants: Array<{ grant: { expiresAt: string } }>;
    };
    state.grants[0]!.grant.expiresAt = new Date(Date.now() - 1).toISOString();
    await writeFile(fixture.autonomyFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const taskBytes = await readFile(fixture.tasksFile, "utf8");

    const shadowed = await run(["shadow", grant.id, "--json"]);

    expect(shadowed.errors).toEqual([]);
    expect(JSON.parse(shadowed.output.join(""))).toMatchObject({ shadowAssessment: "wouldConfirm" });
    expect(await readFile(fixture.tasksFile, "utf8")).toBe(taskBytes);
    const listed = await run(["list", "--json"]);
    expect(JSON.parse(listed.output.join(""))).toMatchObject({ grants: [{ usedCount: 0 }] });
  });

  async function run(args: readonly string[]): Promise<{ readonly errors: string[]; readonly output: string[] }> {
    const output: string[] = [];
    const errors: string[] = [];
    const program = createProgram({
      stderr: (message) => { errors.push(message); },
      stdout: (message) => { output.push(message); }
    } satisfies ProgramIO);
    await program.parseAsync(["node", "muse", "autonomy", ...args], { from: "node" });
    return { errors, output };
  }

  async function createFixture(options: { readonly defaultHomePaths?: boolean } = {}): Promise<{
    readonly attunementFile: string;
    readonly autonomyFile: string;
    readonly opportunitiesFile: string;
    readonly tasksFile: string;
    readonly taskId: string;
    readonly threadId: string;
  }> {
    const dir = await mkdtemp(join(tmpdir(), "muse-autonomy-cli-"));
    dirs.push(dir);
    const dataDir = options.defaultHomePaths ? join(dir, ".muse") : dir;
    const attunementFile = join(dataDir, "attunement.json");
    const tasksFile = join(dataDir, "tasks.json");
    const autonomyFile = join(dataDir, "progressive-autonomy.json");
    const opportunitiesFile = join(dataDir, "progressive-autonomy-opportunities.json");
    const taskId = "task-next";
    const nextEnv: NodeJS.ProcessEnv = {
      ...originalEnv,
      HOME: dir,
      MUSE_USER_ID: "dogfood-user"
    };
    if (options.defaultHomePaths) {
      delete nextEnv.MUSE_ATTUNEMENT_FILE;
      delete nextEnv.MUSE_PROGRESSIVE_AUTONOMY_FILE;
      delete nextEnv.MUSE_PROGRESSIVE_AUTONOMY_OPPORTUNITIES_FILE;
      delete nextEnv.MUSE_TASKS_FILE;
    } else {
      nextEnv.MUSE_ATTUNEMENT_FILE = attunementFile;
      nextEnv.MUSE_PROGRESSIVE_AUTONOMY_FILE = autonomyFile;
      nextEnv.MUSE_PROGRESSIVE_AUTONOMY_OPPORTUNITIES_FILE = opportunitiesFile;
      nextEnv.MUSE_TASKS_FILE = tasksFile;
    }
    process.env = nextEnv;
    await writeTasks(tasksFile, [{
      createdAt: "2026-07-17T00:00:00.000Z",
      id: taskId,
      status: "open",
      title: "Finish the real linked next step"
    }]);
    const thread = await createPersonalThread(attunementFile, { kind: "life", title: "Life" }, {
      idFactory: () => "life",
      now: () => new Date("2026-07-17T01:00:00.000Z")
    });
    await linkArtifact(attunementFile, {
      artifactId: taskId,
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    }, {
      now: () => new Date("2026-07-17T02:00:00.000Z"),
      validateArtifact: async (input) => input
    });
    return {
      attunementFile,
      autonomyFile,
      opportunitiesFile,
      taskId,
      tasksFile,
      threadId: thread.id
    };
  }
});
