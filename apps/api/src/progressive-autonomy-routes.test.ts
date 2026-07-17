import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPersonalThread, linkArtifact } from "@muse/attunement";
import { writeTasks } from "@muse/stores";
import { FileProgressiveAutonomyOpportunityStore } from "@muse/stores/host-progressive-autonomy-opportunities";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerProgressiveAutonomyRoutes } from "./progressive-autonomy-routes.js";
import { attachAuthIdentity } from "./server-helpers.js";

describe("progressive autonomy HTTP review boundary", () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))));

  it("serves loopback review/decision through the shared service and rejects remote or request-supplied identity without writing", async () => {
    const fixture = await createFixture();
    const server = Fastify({ logger: false });
    registerProgressiveAutonomyRoutes(server, {
      attunementFile: fixture.attunementFile,
      defaultUserId: "dogfood-user",
      opportunitiesFile: fixture.opportunitiesFile,
      tasksFile: fixture.tasksFile
    });

    expect((await server.inject({ method: "GET", remoteAddress: "10.0.0.8", url: "/api/autonomy/review" })).statusCode).toBe(403);
    const review = await server.inject({ method: "GET", remoteAddress: "::ffff:127.0.0.1", url: "/api/autonomy/review" });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ opportunity: { opportunityId: "organic-http", currentSource: { state: "exact" } } });
    const beforeIdentity = await readFile(fixture.opportunitiesFile, "utf8");
    const injected = await server.inject({
      method: "POST", payload: { decision: "would-approve", ownerUserId: "dogfood-user" },
      remoteAddress: "127.0.0.1", url: "/api/autonomy/opportunities/organic-http/decision"
    });
    expect(injected.statusCode).toBe(400);
    expect(await readFile(fixture.opportunitiesFile, "utf8")).toBe(beforeIdentity);
    const invalidReason = await server.inject({
      method: "POST", payload: { decision: "would-deny", reason: "bad\u0000reason" },
      remoteAddress: "127.0.0.1", url: "/api/autonomy/opportunities/organic-http/decision"
    });
    expect(invalidReason.statusCode).toBe(400);
    expect(await readFile(fixture.opportunitiesFile, "utf8")).toBe(beforeIdentity);
    const decided = await server.inject({
      method: "POST", payload: { decision: "would-approve", reason: "yes" },
      remoteAddress: "127.0.0.1", url: "/api/autonomy/opportunities/organic-http/decision"
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ review: { decision: "would-approve", reason: "yes" } });
    await server.close();
  });

  it("derives authenticated owner server-side and exposes corruption as 5xx without overwriting bytes", async () => {
    const fixture = await createFixture();
    const authenticated = Fastify({ logger: false });
    authenticated.addHook("onRequest", async (request) => {
      attachAuthIdentity(request, {
        email: "other@example.test", expiresAt: new Date("2026-07-20T00:00:00.000Z"),
        tokenId: "token", userId: "different-user"
      });
    });
    registerProgressiveAutonomyRoutes(authenticated, {
      attunementFile: fixture.attunementFile,
      authService: {} as never,
      defaultUserId: "ignored-default",
      opportunitiesFile: fixture.opportunitiesFile,
      tasksFile: fixture.tasksFile
    });
    const mismatch = await authenticated.inject({
      method: "POST", payload: { decision: "would-deny" },
      url: "/api/autonomy/opportunities/organic-http/decision"
    });
    expect(mismatch.statusCode).toBe(403);
    await authenticated.close();

    const corrupt = "{bad opportunity state\n";
    await writeFile(fixture.opportunitiesFile, corrupt, "utf8");
    const loopback = Fastify({ logger: false });
    registerProgressiveAutonomyRoutes(loopback, {
      attunementFile: fixture.attunementFile,
      defaultUserId: "dogfood-user",
      opportunitiesFile: fixture.opportunitiesFile,
      tasksFile: fixture.tasksFile
    });
    const response = await loopback.inject({ method: "GET", remoteAddress: "::1", url: "/api/autonomy/review" });
    expect(response.statusCode).toBe(500);
    expect(await readFile(fixture.opportunitiesFile, "utf8")).toBe(corrupt);
    await loopback.close();
  });

  async function createFixture() {
    const dir = await mkdtemp(join(tmpdir(), "muse-autonomy-http-"));
    dirs.push(dir);
    const attunementFile = join(dir, "attunement.json");
    const opportunitiesFile = join(dir, "opportunities.json");
    const tasksFile = join(dir, "tasks.json");
    await writeTasks(tasksFile, [{ createdAt: "2026-07-17T00:00:00.000Z", id: "task-next", status: "open", title: "Next" }]);
    const thread = await createPersonalThread(attunementFile, { kind: "life", title: "Life" }, {
      idFactory: () => "life", now: () => new Date("2026-07-17T01:00:00.000Z")
    });
    await linkArtifact(attunementFile, { artifactId: "task-next", artifactType: "task", role: "next-step", threadId: thread.id }, {
      now: () => new Date("2026-07-17T02:00:00.000Z"), validateArtifact: async (input) => input
    });
    await new FileProgressiveAutonomyOpportunityStore({ file: opportunitiesFile }).record({
      enforcementDecision: "confirm",
      envelope: {
        action: "muse.tasks.complete-linked-next-step", idempotencyKey: "runtime-opportunity:run-http:task-next",
        link: { artifactType: "task", linkedAt: "2026-07-17T02:00:00.000Z", providerId: "local", role: "next-step", taskId: "task-next" },
        schemaVersion: 1, threadId: thread.id, traceId: "runtime-tool:run-http:call-1",
        transition: { from: "open", to: "done" }, userId: "dogfood-user"
      },
      evidenceClass: "organic", id: "organic-http", origin: "runtime-opportunity", rationale: "confirm",
      recordedAt: "2026-07-17T03:00:00.000Z", runId: "run-http", shadowAssessment: "wouldConfirm",
      shadowRationale: "no exact active standing grant", toolCallId: "call-1"
    });
    return { attunementFile, opportunitiesFile, tasksFile };
  }
});
