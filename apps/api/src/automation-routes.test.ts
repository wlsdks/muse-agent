import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendInterruptionDelivery,
  writeReminders,
  type PersistedReminder
} from "@muse/stores";
import { MessagingProviderRegistry, type MessagingProvider } from "@muse/messaging";
import { InMemoryScheduledJobStore, type ScheduledJobInput } from "@muse/scheduler";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAutomationRoutes, type AutomationUpcomingResponse } from "./automation-routes.js";
import { createFollowupRuntimeStatusStore } from "./followup-runtime-status.js";
import { createPatternRuntimeStatusStore } from "./pattern-runtime-status.js";
import { createProactiveRuntimeStatusStore } from "./proactive-runtime-status.js";

let root: string;
let remindersFile: string;
let ledgerFile: string;
let ownersFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "muse-automation-api-"));
  remindersFile = join(root, "reminders.json");
  ledgerFile = join(root, "interruption-ledger.json");
  ownersFile = join(root, "channel-owners.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const PENDING_REMINDER: PersistedReminder = {
  createdAt: "2026-07-16T00:00:00.000Z",
  dueAt: "2026-07-18T09:00:00.000Z",
  id: "rem_1",
  status: "pending",
  text: "Call the vet"
};

const LATER_PENDING_REMINDER: PersistedReminder = {
  createdAt: "2026-07-16T00:00:00.000Z",
  dueAt: "2026-07-20T09:00:00.000Z",
  id: "rem_2",
  status: "pending",
  text: "Renew passport"
};

const FIRED_REMINDER: PersistedReminder = {
  createdAt: "2026-07-15T00:00:00.000Z",
  dueAt: "2026-07-16T09:00:00.000Z",
  firedAt: "2026-07-16T09:00:00.000Z",
  id: "rem_0",
  status: "fired",
  text: "Already sent"
};

const JOB_INPUT: ScheduledJobInput = {
  cronExpression: "0 9 * * *",
  enabled: true,
  jobType: "agent",
  name: "Morning brief"
};

function registryOf(...providers: readonly { id: string; local?: boolean }[]): MessagingProviderRegistry {
  const entries: MessagingProvider[] = providers.map(({ id, local }) => ({
    describe: () => ({ description: "test provider", displayName: id, id, ...(local ? { local } : {}) }),
    id,
    send: async (message) => ({ destination: message.destination, messageId: `test-${id}`, providerId: id })
  }));
  return new MessagingProviderRegistry(entries);
}

describe("GET /api/automation/upcoming — empty stores", () => {
  it("returns null digest/reminder and an empty jobs list when nothing is configured (budget is always-on with its own defaults)", async () => {
    const server = Fastify();
    registerAutomationRoutes(server, { authService: undefined, env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile } });
    const res = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as AutomationUpcomingResponse;
    expect(body).toEqual({
      budget: { dayCap: 6, dayUsed: 0, hourCap: 2, hourUsed: 0 },
      channelRuntime: { daemons: [], status: "unconfigured" },
      deliveryQueueSnapshot: {
        followups: {
          overdue: { count: 0, oldestAgeMs: null },
          scheduled: { count: 0, oldestAgeMs: null }
        },
        generatedAt: expect.any(String),
        pendingDrafts: { count: 0, oldestAgeMs: null },
        reminders: {
          overdue: { count: 0, oldestAgeMs: null },
          scheduled: { count: 0, oldestAgeMs: null }
        },
        status: "observed"
      },
      digest: null,
      digestRuntime: null,
      followupRuntime: null,
      gateway: {
        destination: null,
        localOnly: false,
        providerId: null,
        reason: "paired-route-inspection-unavailable",
        source: null,
        status: "unconfigured"
      },
      nextReminder: null,
      patternRuntime: null,
      proactiveRuntime: null,
      reminderRuntime: null,
      scheduledJobs: []
    });
  });

  it("returns a budget section from an empty/missing ledger file (all zero used)", async () => {
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      env: { MUSE_INTERRUPTION_DAILY_CAP: "6", MUSE_INTERRUPTION_HOURLY_CAP: "2", MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile }
    });
    const res = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as AutomationUpcomingResponse;
    expect(body.budget).toEqual({ dayCap: 6, dayUsed: 0, hourCap: 2, hourUsed: 0 });
  });

  it("keeps the delivery queue snapshot behind the existing authentication gate", async () => {
    const server = Fastify();
    let statusGetterCalls = 0;
    registerAutomationRoutes(server, { authService: {} as never, env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile } });

    const res = await server.inject({ method: "GET", url: "/api/automation/upcoming" });

    expect(res.statusCode).toBe(401);

    const guardedServer = Fastify();
    registerAutomationRoutes(guardedServer, {
      authService: {} as never,
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile },
      proactiveRuntimeStatus: () => {
        statusGetterCalls += 1;
        return null;
      }
    });
    expect((await guardedServer.inject({ method: "GET", url: "/api/automation/upcoming" })).statusCode).toBe(401);
    expect(statusGetterCalls).toBe(0);
  });

  it("projects every delivery bucket without exposing source fields", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60_000;
    const privateText = "PRIVATE DELIVERY TEXT";
    const followups = join(root, "followups.json");
    const reminders = join(root, "reminders.json");
    const pending = join(root, "pending-approvals.json");
    await writeFile(followups, JSON.stringify({ followups: [
      {
        createdAt: new Date(now - 3 * day).toISOString(),
        scheduledFor: new Date(now - day).toISOString(),
        status: "scheduled",
        summary: privateText
      },
      {
        createdAt: new Date(now - 2 * day).toISOString(),
        scheduledFor: new Date(now + day).toISOString(),
        status: "scheduled",
        summary: privateText
      }
    ] }));
    await writeFile(reminders, JSON.stringify({ reminders: [
      {
        createdAt: new Date(now - 4 * day).toISOString(),
        dueAt: new Date(now - 2 * day).toISOString(),
        status: "pending",
        text: privateText
      },
      {
        createdAt: new Date(now - day).toISOString(),
        dueAt: new Date(now + day).toISOString(),
        status: "pending",
        text: privateText
      }
    ] }));
    await writeFile(pending, JSON.stringify({ pending: [{
      arguments: { text: privateText },
      createdAt: new Date(now - 5 * day).toISOString(),
      draft: privateText,
      expiresAt: new Date(now + day).toISOString(),
      id: "approval-private",
      providerId: "provider-private",
      risk: "execute",
      source: "source-private",
      tool: "send_message"
    }] }));

    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      env: {
        MUSE_FOLLOWUPS_FILE: followups,
        MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile,
        MUSE_PENDING_APPROVALS_FILE: pending,
        MUSE_REMINDERS_FILE: reminders
      }
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    const body = JSON.parse(response.body) as AutomationUpcomingResponse;
    const snapshot = body.deliveryQueueSnapshot;

    expect(response.statusCode).toBe(200);
    expect(snapshot).toEqual({
      followups: {
        overdue: { count: 1, oldestAgeMs: expect.any(Number) },
        scheduled: { count: 2, oldestAgeMs: expect.any(Number) }
      },
      generatedAt: expect.any(String),
      pendingDrafts: { count: 1, oldestAgeMs: expect.any(Number) },
      reminders: {
        overdue: { count: 1, oldestAgeMs: expect.any(Number) },
        scheduled: { count: 2, oldestAgeMs: expect.any(Number) }
      },
      status: "observed"
    });
    expect(JSON.stringify(snapshot)).not.toContain(privateText);
    expect(JSON.stringify(snapshot)).not.toMatch(/approval-private|provider-private|source-private|send_message|"arguments"|"text"|"summary"/iu);
    for (const bucket of [
      snapshot.pendingDrafts,
      snapshot.followups.overdue,
      snapshot.followups.scheduled,
      snapshot.reminders.overdue,
      snapshot.reminders.scheduled
    ]) {
      expect(bucket.count).toBeGreaterThanOrEqual(0);
      expect(bucket.count).toBeLessThanOrEqual(9_999);
      expect(bucket.oldestAgeMs).toBeGreaterThanOrEqual(0);
      expect(bucket.oldestAgeMs).toBeLessThanOrEqual(1000 * 60 * 60 * 24 * 365 * 100);
    }
  });

  it("reports an unverified queue without returning corrupt source details", async () => {
    const followups = join(root, "corrupt-followups.json");
    const reminders = join(root, "valid-reminders.json");
    const pending = join(root, "valid-pending.json");
    await writeFile(followups, "{ corrupt private source");
    await writeFile(reminders, JSON.stringify({ reminders: [] }));
    await writeFile(pending, JSON.stringify({ pending: [] }));

    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      env: {
        MUSE_FOLLOWUPS_FILE: followups,
        MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile,
        MUSE_PENDING_APPROVALS_FILE: pending,
        MUSE_REMINDERS_FILE: reminders
      }
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    const snapshot = (JSON.parse(response.body) as AutomationUpcomingResponse).deliveryQueueSnapshot;

    expect(snapshot.status).toBe("unverified");
    expect(snapshot.followups).toEqual({
      overdue: { count: 0, oldestAgeMs: null },
      scheduled: { count: 0, oldestAgeMs: null }
    });
    expect(response.body).not.toContain("corrupt private source");
  });
});

describe("GET /api/automation/upcoming — pattern runtime projection", () => {
  it("projects only bounded pattern runtime fields and preserves authentication", async () => {
    const runtimeStatus = createPatternRuntimeStatusStore();
    runtimeStatus.record({
      decision: "error",
      observedAtIso: "not-a-date",
      fireableCount: 10_000,
      deliveredCount: -1,
      firedCount: 2,
      errorCount: 3
    });
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile },
      patternRuntimeStatus: runtimeStatus.get
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AutomationUpcomingResponse;
    expect(body.patternRuntime).toEqual({
      lastDecision: "error",
      lastObservedAtIso: "not-a-date",
      lastFireableCount: 9_999,
      lastDeliveredCount: 0,
      lastFiredCount: 2,
      lastErrorCount: 3
    });
    expect(Object.keys(body.patternRuntime ?? {}).sort()).toEqual([
      "lastDecision",
      "lastDeliveredCount",
      "lastErrorCount",
      "lastFireableCount",
      "lastFiredCount",
      "lastObservedAtIso"
    ]);
    const serialized = JSON.stringify(body.patternRuntime);
    expect(serialized).not.toContain("pattern-id");
    expect(serialized).not.toContain("suggestion");
    expect(serialized).not.toContain("provider");
    expect(serialized).not.toContain("destination");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("raw error");

    const protectedServer = Fastify();
    registerAutomationRoutes(protectedServer, {
      authService: {} as never,
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile },
      patternRuntimeStatus: runtimeStatus.get
    });
    expect((await protectedServer.inject({ method: "GET", url: "/api/automation/upcoming" })).statusCode).toBe(401);
  });
});

describe("GET /api/automation/upcoming — populated stores", () => {
  it("projects the legacy briefing pair with the same precedence used by the API briefing tick", async () => {
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      env: {
        MUSE_BRIEFING_DESTINATION: "briefing-555",
        MUSE_BRIEFING_PROVIDER: "telegram",
        MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile
      },
      messagingRegistry: registryOf({ id: "telegram" })
    });

    const legacy = JSON.parse((await server.inject({ method: "GET", url: "/api/automation/upcoming" })).body) as AutomationUpcomingResponse;
    expect(legacy.gateway).toMatchObject({
      destination: "briefing-555",
      providerId: "telegram",
      source: "explicit-config",
      status: "resolved"
    });

    const canonicalServer = Fastify();
    registerAutomationRoutes(canonicalServer, {
      authService: undefined,
      env: {
        MUSE_BRIEFING_DESTINATION: "briefing-555",
        MUSE_BRIEFING_PROVIDER: "telegram",
        MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile,
        MUSE_PROACTIVE_DESTINATION: "proactive-999",
        MUSE_PROACTIVE_PROVIDER: "telegram"
      },
      messagingRegistry: registryOf({ id: "telegram" })
    });
    const canonical = JSON.parse((await canonicalServer.inject({ method: "GET", url: "/api/automation/upcoming" })).body) as AutomationUpcomingResponse;
    expect(canonical.gateway).toMatchObject({ destination: "proactive-999", providerId: "telegram", status: "resolved" });
  });

  it("surfaces the digest config, the counted budget, the soonest pending reminder, and the soonest enabled job", async () => {
    await writeReminders(remindersFile, [FIRED_REMINDER, LATER_PENDING_REMINDER, PENDING_REMINDER]);
    await appendInterruptionDelivery(ledgerFile, { at: new Date(), source: "pattern-firing" });

    let jobIdCounter = 0;
    const jobStore = new InMemoryScheduledJobStore({
      idFactory: () => `job_${(jobIdCounter += 1).toString()}`,
      now: () => new Date("2026-07-17T00:00:00.000Z")
    });
    await jobStore.save(JOB_INPUT);
    await jobStore.save({ ...JOB_INPUT, enabled: false, name: "Disabled job" });

    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      env: {
        MUSE_DIGEST_ENABLED: "false",
        MUSE_DIGEST_HOUR: "9",
        MUSE_INTERRUPTION_DAILY_CAP: "6",
        MUSE_INTERRUPTION_HOURLY_CAP: "2",
        MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile,
        MUSE_PROACTIVE_DESTINATION: "12345",
        MUSE_PROACTIVE_PROVIDER: "telegram"
      },
      messagingRegistry: registryOf({ id: "telegram" }),
      channelOwnersFile: ownersFile,
      remindersFile,
      scheduler: { store: jobStore }
    });

    const res = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as AutomationUpcomingResponse;

    expect(body.digest).toMatchObject({ enabled: false, hour: 9 });
    expect(body.digestRuntime).toBeNull();
    expect(body.reminderRuntime).toBeNull();
    expect(typeof body.digest?.nextAtIso).toBe("string");
    expect(body.gateway).toEqual({
      destination: "12345",
      localOnly: false,
      providerId: "telegram",
      reason: null,
      source: "explicit-config",
      status: "resolved"
    });

    expect(body.budget).toEqual({ dayCap: 6, dayUsed: 1, hourCap: 2, hourUsed: 1 });

    expect(body.nextReminder).toEqual({ dueAtIso: "2026-07-18T09:00:00.000Z", id: "rem_1", text: "Call the vet" });

    expect(body.scheduledJobs).toHaveLength(1);
    expect(body.scheduledJobs[0]).toMatchObject({ label: "Morning brief" });
    expect(typeof body.scheduledJobs[0]!.nextRunAtIso).toBe("string");
  });
});

describe("GET /api/automation/upcoming — proactive runtime status", () => {
  it("returns the bounded process-local observation without raw runtime fields", async () => {
    const runtimeStatus = createProactiveRuntimeStatusStore();
    runtimeStatus.record({
      decision: "fired",
      observedAtIso: "2026-08-08T01:02:03.000Z",
      imminentCount: 2,
      firedCount: 1,
      suppressedCount: 1,
      errorCount: 0,
      lastRoute: {
        destination: "owner-a",
        localOnly: false,
        providerId: "telegram",
        reason: null,
        source: "explicit-config",
        status: "resolved"
      },
      sessionLockedUntilIso: "2026-08-08T01:12:03.000Z"
    });
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile },
      proactiveRuntimeStatus: runtimeStatus.get
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AutomationUpcomingResponse;
    expect(body.proactiveRuntime).toEqual({
      lastDecision: "fired",
      lastObservedAtIso: "2026-08-08T01:02:03.000Z",
      lastRoute: {
        destination: "owner-a",
        localOnly: false,
        providerId: "telegram",
        reason: null,
        source: "explicit-config",
        status: "resolved"
      },
      lastImminentCount: 2,
      lastFiredCount: 1,
      lastSuppressedCount: 1,
      lastErrorCount: 0,
      sessionLockedUntilIso: "2026-08-08T01:12:03.000Z"
    });
    expect(response.body).not.toContain("raw error");
    expect(response.body).not.toContain("notice text");
    expect(response.body).not.toContain("provider-id");
    expect(response.body).not.toContain("credential");
  });

  it("projects both runtime receipts through the exact nested six-field allowlist", async () => {
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile },
      digestRuntimeStatus: () => ({
        lastDecision: "sent",
        lastErrorCount: 0,
        lastItemCount: 1,
        lastObservedAtIso: "2026-08-08T01:02:03.000Z",
        lastRoute: {
          destination: "owner-a",
          localOnly: false,
          providerId: "telegram",
          reason: null,
          source: "explicit-config",
          status: "resolved",
          rawError: "secret error",
          provider: { credential: "secret credential" }
        }
      } as never),
      proactiveRuntimeStatus: () => ({
        lastDecision: "fired",
        lastErrorCount: 0,
        lastFiredCount: 1,
        lastImminentCount: 1,
        lastObservedAtIso: "2026-08-08T01:02:03.000Z",
        lastSuppressedCount: 0,
        lastRoute: {
          destination: null,
          localOnly: true,
          providerId: null,
          reason: "remote-route-blocked-by-local-only",
          source: "explicit-config",
          status: "blocked-local-only",
          message: "private content",
          path: "/private/path"
        }
      } as never)
    });

    const body = (await server.inject({ method: "GET", url: "/api/automation/upcoming" })).json() as AutomationUpcomingResponse;
    expect(Object.keys(body.digestRuntime?.lastRoute ?? {}).sort()).toEqual([
      "destination",
      "localOnly",
      "providerId",
      "reason",
      "source",
      "status"
    ]);
    expect(Object.keys(body.proactiveRuntime?.lastRoute ?? {}).sort()).toEqual([
      "destination",
      "localOnly",
      "providerId",
      "reason",
      "source",
      "status"
    ]);
    expect(JSON.stringify(body)).not.toMatch(/secret error|secret credential|private content|private\/path/iu);
  });
});

describe("GET /api/automation/upcoming — reminder runtime status", () => {
  it("returns only the bounded process-local observation without raw reminder fields", async () => {
    const runtimeStatus = {
      get: () => ({
        lastDecision: "fired" as const,
        lastObservedAtIso: "2026-08-08T01:02:03.000Z",
        lastDueCount: 2,
        lastDeliveredCount: 1,
        lastFiredCount: 1,
        lastErrorCount: 0
      })
    };
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile },
      reminderRuntimeStatus: runtimeStatus.get
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AutomationUpcomingResponse;
    expect(body.reminderRuntime).toEqual({
      lastDecision: "fired",
      lastObservedAtIso: "2026-08-08T01:02:03.000Z",
      lastDueCount: 2,
      lastDeliveredCount: 1,
      lastFiredCount: 1,
      lastErrorCount: 0
    });
    const reminderProjection = JSON.stringify(body.reminderRuntime);
    expect(reminderProjection).not.toContain("reminder text");
    expect(reminderProjection).not.toContain("provider-id");
    expect(reminderProjection).not.toContain("destination");
    expect(reminderProjection).not.toContain("credential");
    expect(reminderProjection).not.toContain("file-path");
  });
});

describe("GET /api/automation/upcoming — follow-up runtime status", () => {
  it("returns only bounded process-local follow-up metadata and preserves authentication", async () => {
    const runtimeStatus = createFollowupRuntimeStatusStore();
    runtimeStatus.record({
      decision: "fired",
      observedAtIso: "2026-08-08T01:02:03.000Z",
      dueCount: 2,
      deliveredCount: 1,
      firedCount: 2,
      errorCount: 0
    });
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile },
      followupRuntimeStatus: runtimeStatus.get
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AutomationUpcomingResponse;
    expect(body.followupRuntime).toEqual({
      lastDecision: "fired",
      lastObservedAtIso: "2026-08-08T01:02:03.000Z",
      lastDueCount: 2,
      lastDeliveredCount: 1,
      lastFiredCount: 2,
      lastErrorCount: 0
    });
    const followupProjection = JSON.stringify(body.followupRuntime);
    expect(followupProjection).not.toContain("follow-up summary");
    expect(followupProjection).not.toContain("raw error");
    expect(followupProjection).not.toContain("provider-id");
    expect(followupProjection).not.toContain("destination");
    expect(followupProjection).not.toContain("credential");
    expect(followupProjection).not.toContain("file-path");

    const protectedServer = Fastify();
    registerAutomationRoutes(protectedServer, {
      authService: {} as never,
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile },
      followupRuntimeStatus: runtimeStatus.get
    });
    expect((await protectedServer.inject({ method: "GET", url: "/api/automation/upcoming" })).statusCode).toBe(401);
  });
});

describe("GET /api/automation/upcoming — Gateway route status", () => {
  it("resolves one exact paired owner and never guesses across two", async () => {
    await writeFile(ownersFile, JSON.stringify({ owners: { telegram: "555" }, version: 1 }));
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      channelOwnersFile: ownersFile,
      env: { MUSE_DIGEST_HOUR: "9", MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile },
      messagingRegistry: registryOf({ id: "telegram" })
    });

    const resolved = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    const resolvedBody = JSON.parse(resolved.body) as AutomationUpcomingResponse;
    expect(resolvedBody.digest).toMatchObject({ enabled: true, hour: 9 });
    expect(resolvedBody.digestRuntime).toBeNull();
    expect(typeof resolvedBody.digest?.nextAtIso).toBe("string");
    expect(resolvedBody.gateway).toEqual({
      destination: "555",
      localOnly: false,
      providerId: "telegram",
      reason: null,
      source: "paired-owner",
      status: "resolved"
    });

    await writeFile(ownersFile, JSON.stringify({ owners: { discord: "999", telegram: "555" }, version: 1 }));
    const ambiguousServer = Fastify();
    registerAutomationRoutes(ambiguousServer, {
      authService: undefined,
      channelOwnersFile: ownersFile,
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile },
      messagingRegistry: registryOf({ id: "telegram" }, { id: "discord" })
    });
    const ambiguous = await ambiguousServer.inject({ method: "GET", url: "/api/automation/upcoming" });
    const ambiguousBody = JSON.parse(ambiguous.body) as AutomationUpcomingResponse;
    expect(ambiguousBody.digest).toBeNull();
    expect(ambiguousBody.gateway).toMatchObject({
      providerId: null,
      reason: "multiple-paired-routes",
      status: "ambiguous"
    });
  });

  it("hides the digest for partial or unregistered explicit routes even when a pair exists", async () => {
    await writeFile(ownersFile, JSON.stringify({ owners: { telegram: "555" }, version: 1 }));

    const partialServer = Fastify();
    registerAutomationRoutes(partialServer, {
      authService: undefined,
      channelOwnersFile: ownersFile,
      env: {
        MUSE_DIGEST_HOUR: "9",
        MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile,
        MUSE_PROACTIVE_PROVIDER: "telegram"
      },
      messagingRegistry: registryOf({ id: "telegram" })
    });
    const partial = await partialServer.inject({ method: "GET", url: "/api/automation/upcoming" });
    const partialBody = JSON.parse(partial.body) as AutomationUpcomingResponse;
    expect(partialBody.digest).toBeNull();
    expect(partialBody.gateway).toMatchObject({ reason: "explicit-route-incomplete", status: "unconfigured" });

    const unregisteredServer = Fastify();
    registerAutomationRoutes(unregisteredServer, {
      authService: undefined,
      channelOwnersFile: ownersFile,
      env: {
        MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile,
        MUSE_PROACTIVE_DESTINATION: "12345",
        MUSE_PROACTIVE_PROVIDER: "discord"
      },
      messagingRegistry: registryOf({ id: "telegram" })
    });
    const unregistered = await unregisteredServer.inject({ method: "GET", url: "/api/automation/upcoming" });
    const unregisteredBody = JSON.parse(unregistered.body) as AutomationUpcomingResponse;
    expect(unregisteredBody.digest).toBeNull();
    expect(unregisteredBody.gateway).toMatchObject({ reason: "explicit-provider-not-registered", status: "unconfigured" });
  });

  it("blocks an explicit remote route under local-only while allowing a local provider", async () => {
    const remoteServer = Fastify();
    registerAutomationRoutes(remoteServer, {
      authService: undefined,
      env: {
        MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile,
        MUSE_LOCAL_ONLY: "true",
        MUSE_PROACTIVE_DESTINATION: "12345",
        MUSE_PROACTIVE_PROVIDER: "telegram"
      }
    });
    const blocked = await remoteServer.inject({ method: "GET", url: "/api/automation/upcoming" });
    const blockedBody = JSON.parse(blocked.body) as AutomationUpcomingResponse;
    expect(blockedBody.digest).toBeNull();
    expect(blockedBody.gateway).toMatchObject({
      destination: "12345",
      localOnly: true,
      providerId: "telegram",
      reason: "remote-route-blocked-by-local-only",
      status: "blocked-local-only"
    });

    const localServer = Fastify();
    registerAutomationRoutes(localServer, {
      authService: undefined,
      env: {
        MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile,
        MUSE_LOCAL_ONLY: "true",
        MUSE_PROACTIVE_DESTINATION: "desktop",
        MUSE_PROACTIVE_PROVIDER: "log"
      },
      messagingRegistry: registryOf({ id: "log", local: true })
    });
    const local = await localServer.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect((JSON.parse(local.body) as AutomationUpcomingResponse).gateway.status).toBe("resolved");
  });
});

describe("GET /api/automation/upcoming — channel runtime projection", () => {
  it("returns an unconfigured channel runtime when no known daemon is registered", async () => {
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile }
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect((JSON.parse(response.body) as AutomationUpcomingResponse).channelRuntime).toEqual({
      daemons: [],
      status: "unconfigured"
    });
  });

  it("projects only fixed-known daemons with bounded safe values and no raw operational data", async () => {
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      channelDaemonStatus: () => ({
        "discord-poll": {
          lastError: "token=secret raw error /private/channel-id",
          lastErrorAtIso: "not-a-date",
          lastIngestCount: Number.NaN,
          lastIngestAtIso: "2026-08-08T08:00:00.000Z",
          running: false
        },
        "not-a-known-daemon": {
          lastError: "should not cross the projection",
          running: true
        }
      }),
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile }
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    const body = JSON.parse(response.body) as AutomationUpcomingResponse;
    expect(body.channelRuntime).toEqual({
      daemons: [{
        hasError: true,
        kind: "discord-poll",
        lastErrorAtIso: null,
        lastIngestAtIso: "2026-08-08T08:00:00.000Z",
        lastIngestCount: null,
        running: false
      }],
      status: "degraded"
    });
    const projection = JSON.stringify(body.channelRuntime);
    expect(projection).not.toContain("secret");
    expect(projection).not.toContain("private");
    expect(projection).not.toContain("channel-id");
  });

  it("reports observed state, bounds counts, and remains authenticated", async () => {
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      channelDaemonStatus: () => ({
        "slack-poll": {
          lastIngestCount: 100_000,
          lastIngestAtIso: "2026-08-08T08:00:00+09:00",
          running: true
        }
      }),
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile }
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    const body = JSON.parse(response.body) as AutomationUpcomingResponse;
    expect(body.channelRuntime).toEqual({
      daemons: [{
        hasError: false,
        kind: "slack-poll",
        lastErrorAtIso: null,
        lastIngestAtIso: "2026-08-07T23:00:00.000Z",
        lastIngestCount: 9_999,
        running: true
      }],
      status: "observed"
    });

    const protectedServer = Fastify();
    registerAutomationRoutes(protectedServer, {
      authService: {} as never,
      channelDaemonStatus: () => ({}),
      env: { MUSE_INTERRUPTION_LEDGER_FILE: ledgerFile }
    });
    expect((await protectedServer.inject({ method: "GET", url: "/api/automation/upcoming" })).statusCode).toBe(401);
  });
});
