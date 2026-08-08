import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { writeDayRhythmConfig } from "@muse/autoconfigure";
import { CalendarProviderRegistry } from "@muse/calendar";
import * as domainTools from "@muse/domain-tools";
import { MessagingProviderRegistry, readOutboundEffects } from "@muse/messaging";
import { readCheckins, writeCheckins } from "@muse/proactivity";
import { addObjective, readFollowups, setSchedulerPaused, writeFollowups } from "@muse/stores";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeBriefingTick, makeCheckinsTick, makeDailyBriefTick, makeFollowupTick, makePatternTick, makeSchedulerTick } from "./daemon-delivery-ticks.js";
import type { MakeDailyBriefTickDeps } from "./daemon-delivery-ticks.js";
import type { SchedulerJobOutcome } from "./scheduler-job-runner.js";

import type { JobExecutionStatus, ScheduledJob, ScheduledJobInput, ScheduledJobStore } from "@muse/scheduler";
import type { UserMemoryStore, UserModel, UserModelSlot } from "@muse/memory";

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    agentPrompt: "summarize today",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    cronExpression: "0 9 * * *",
    enabled: true,
    id: "job-1",
    jobType: "agent",
    maxRetryCount: 3,
    name: "morning-brief",
    retryOnFailure: false,
    tags: [],
    timezone: "UTC",
    toolArguments: {},
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides
  };
}

/** Minimal in-memory ScheduledJobStore fake with an update-call log, so
 *  tests can assert exactly which status transitions the tick wrote. */
class FakeStore implements ScheduledJobStore {
  readonly updateCalls: Array<{ id: string; status: JobExecutionStatus; result?: string | null }> = [];
  private readonly jobs = new Map<string, ScheduledJob>();

  constructor(initial: readonly ScheduledJob[] = []) {
    for (const j of initial) this.jobs.set(j.id, j);
  }

  list(): readonly ScheduledJob[] {
    return [...this.jobs.values()];
  }

  findById(id: string): ScheduledJob | undefined {
    return this.jobs.get(id);
  }

  findByName(name: string): ScheduledJob | undefined {
    return [...this.jobs.values()].find((j) => j.name === name);
  }

  save(input: ScheduledJobInput): ScheduledJob {
    const saved = job({ ...(input as Partial<ScheduledJob>), id: input.id ?? `job-${(this.jobs.size + 1).toString()}` });
    this.jobs.set(saved.id, saved);
    return saved;
  }

  update(id: string, input: ScheduledJobInput): ScheduledJob | undefined {
    const existing = this.jobs.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...(input as Partial<ScheduledJob>) };
    this.jobs.set(id, updated);
    return updated;
  }

  delete(id: string): void {
    this.jobs.delete(id);
  }

  updateExecutionResult(id: string, status: JobExecutionStatus, result?: string | null): void {
    this.updateCalls.push({ id, result, status });
    const existing = this.jobs.get(id);
    if (existing) {
      this.jobs.set(id, { ...existing, lastResult: result ?? undefined, lastStatus: status, updatedAt: new Date() });
    }
  }
}

function fakeMessaging() {
  const sent: Array<{ providerId: string; destination: string; text: string }> = [];
  return {
    sent,
    send: async (providerId: string, message: { destination: string; text: string }) => {
      sent.push({ destination: message.destination, providerId, text: message.text });
      return { providerId, status: "sent" as const };
    }
  };
}

function tmpPauseFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-scheduler-tick-")), "scheduler-paused.json");
}

describe("makeFollowupTick", () => {
  it("forwards the canonical effect ledger and completes one accepted occurrence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cli-followup-tick-"));
    const effectFile = join(dir, "outbound-effects.json");
    const followupsFile = join(dir, "followups.json");
    await writeFollowups(followupsFile, [{
      createdAt: "2026-07-26T20:00:00.000Z",
      id: "cli-followup-effect",
      scheduledFor: "2026-07-26T00:00:00.000Z",
      status: "scheduled",
      summary: "Check deployment",
      userId: "owner"
    }]);
    const registry = new MessagingProviderRegistry([{
      describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
      id: "telegram",
      send: async (message) => ({
        destination: message.destination,
        messageId: "cli-followup-accepted",
        providerId: "telegram"
      })
    }]);
    const tick = makeFollowupTick({
      destination: "@owner",
      effectFile,
      followupModel: {
        model: "test-model",
        modelProvider: { generate: async () => ({ output: "Did it finish?" }) }
      },
      followupsFile,
      interruptionBudget: {
        dailyCap: 5,
        digestFile: join(dir, "digest.json"),
        hourlyCap: 5,
        ledgerFile: join(dir, "interruption-ledger.json")
      },
      messagingRegistry: registry,
      provider: "telegram",
      stdout: () => undefined
    });

    await tick(() => true);
    expect(await readOutboundEffects(effectFile)).toHaveLength(1);
    expect((await readFollowups(followupsFile))[0]!.status).toBe("fired");
  });
});

describe("makeCheckinsTick", () => {
  it("forwards the canonical effect ledger and completes one accepted check-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cli-checkin-tick-"));
    const checkinsFile = join(dir, "checkins.json");
    const effectFile = join(dir, "outbound-effects.json");
    await writeCheckins(checkinsFile, [{
      commitment: "Check deployment",
      createdAt: "2026-07-26T20:00:00.000Z",
      dueAtIso: "1970-01-01T00:00:00.000Z",
      id: "cli-checkin-effect",
      question: "Did deployment finish?",
      sourceKey: "check deployment",
      status: "scheduled",
      userId: "owner"
    }]);
    const registry = new MessagingProviderRegistry([{
      describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
      id: "telegram",
      send: async (message) => ({
        destination: message.destination,
        messageId: "cli-checkin-accepted",
        providerId: "telegram"
      })
    }]);
    const tick = makeCheckinsTick({
      destination: "@owner",
      effectFile,
      env: { MUSE_CHECKINS_FILE: checkinsFile },
      interruptionBudget: {
        dailyCap: 5,
        digestFile: join(dir, "digest.json"),
        hourlyCap: 5,
        ledgerFile: join(dir, "interruption-ledger.json")
      },
      messagingRegistry: registry,
      provider: "telegram",
      quietHours: undefined,
      stdout: () => undefined
    });

    await tick();
    expect(await readOutboundEffects(effectFile)).toHaveLength(1);
    expect((await readCheckins(checkinsFile))[0]!.status).toBe("fired");
  });
});

describe("makePatternTick", () => {
  it("forwards the canonical effect ledger for one accepted natural slot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cli-pattern-tick-"));
    const notesDir = join(dir, "notes");
    const patternsFiredFile = join(dir, "patterns-fired.json");
    const effectFile = join(dir, "outbound-effects.json");
    const now = new Date();
    mkdirSync(join(notesDir, "journal"), { recursive: true });
    for (let k = 1; k <= 5; k += 1) {
      const file = join(notesDir, "journal", `entry-${k.toString()}.md`);
      writeFileSync(file, `journal ${k.toString()}`, "utf8");
      const when = new Date(now.getTime() - k * 7 * 86_400_000);
      utimesSync(file, when, when);
    }
    const registry = new MessagingProviderRegistry([{
      describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
      id: "telegram",
      send: async (message) => ({
        destination: message.destination,
        messageId: "cli-pattern-accepted",
        providerId: "telegram"
      })
    }]);
    const tick = makePatternTick({
      destination: "@owner",
      effectFile,
      env: {
        MUSE_NOTES_DIR: notesDir,
        MUSE_PATTERNS_FIRED_FILE: patternsFiredFile
      },
      followupModel: undefined,
      interruptionBudget: {
        dailyCap: 5,
        digestFile: join(dir, "digest.json"),
        hourlyCap: 5,
        ledgerFile: join(dir, "interruption-ledger.json")
      },
      messagingRegistry: registry,
      provider: "telegram",
      quietHours: undefined,
      signals: { notesDir },
      stdout: () => undefined
    });

    await tick(() => true);
    expect(await readOutboundEffects(effectFile)).toHaveLength(1);
  });
});

describe("makeSchedulerTick", () => {
  const out: string[] = [];
  const stdout = (m: string) => out.push(m);
  afterEach(() => { out.length = 0; });

  it("does nothing and logs 'paused' when the scheduler pause file is set — the store is never even read", async () => {
    const pauseFile = tmpPauseFile();
    await setSchedulerPaused(pauseFile, true);
    const store = new FakeStore([job()]);
    const messaging = fakeMessaging();
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never, pauseFile, provider: "log",
      schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(out.join("")).toContain("paused");
    expect(store.updateCalls).toEqual([]);
    expect(messaging.sent).toEqual([]);
  });

  it("skips a job that is not yet due", async () => {
    const pauseFile = tmpPauseFile();
    const store = new FakeStore([job({ cronExpression: "0 9 * * *", createdAt: new Date("2026-06-01T03:00:00Z") })]);
    const messaging = fakeMessaging();
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T08:00:00Z"),
      pauseFile, provider: "log", schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(store.updateCalls).toEqual([]);
    expect(messaging.sent).toEqual([]);
    expect(out.join("")).toContain("fired 0/0 due");
  });

  it("a due job runs, is marked running then success, and its result is delivered to the daemon default destination", async () => {
    const pauseFile = tmpPauseFile();
    const created = new Date("2026-06-01T00:00:00Z");
    const store = new FakeStore([job({ createdAt: created, cronExpression: "0 9 * * *" })]);
    const messaging = fakeMessaging();
    const runJob = async (): Promise<SchedulerJobOutcome> => ({ status: "success", text: "3 meetings today" });
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T09:00:00Z"),
      pauseFile, provider: "log", runJob, schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(store.updateCalls.map((c) => c.status)).toEqual(["running", "success"]);
    expect(store.updateCalls[1]?.result).toBe("3 meetings today");
    expect(messaging.sent).toEqual([{ destination: "@me", providerId: "log", text: "3 meetings today" }]);
    expect(out.join("")).toContain("fired 1/1 due");
  });

  it("a job's own notificationChannelId ('provider:destination') overrides the daemon default routing", async () => {
    const pauseFile = tmpPauseFile();
    const created = new Date("2026-06-01T00:00:00Z");
    const store = new FakeStore([job({ createdAt: created, notificationChannelId: "telegram:98765" })]);
    const messaging = fakeMessaging();
    const runJob = async (): Promise<SchedulerJobOutcome> => ({ status: "success", text: "hi" });
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T09:00:00Z"),
      pauseFile, provider: "log", runJob, schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(messaging.sent).toEqual([{ destination: "98765", providerId: "telegram", text: "hi" }]);
  });

  it("SAFETY: a failed/timed-out execution mutates ONLY lastStatus/lastResult — no delivery of partial text", async () => {
    const pauseFile = tmpPauseFile();
    const created = new Date("2026-06-01T00:00:00Z");
    const store = new FakeStore([job({ createdAt: created })]);
    const messaging = fakeMessaging();
    const runJob = async (): Promise<SchedulerJobOutcome> => ({ error: "model provider unavailable", status: "failed" });
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T09:00:00Z"),
      pauseFile, provider: "log", runJob, schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(store.updateCalls.map((c) => c.status)).toEqual(["running", "failed"]);
    expect(messaging.sent).toEqual([]); // NEVER delivers on failure
    expect(out.join("")).toContain("model provider unavailable");
  });

  it("SAFETY: a timeout outcome also mutates only lastStatus/lastResult and never delivers", async () => {
    const pauseFile = tmpPauseFile();
    const created = new Date("2026-06-01T00:00:00Z");
    const store = new FakeStore([job({ createdAt: created })]);
    const messaging = fakeMessaging();
    const runJob = async (): Promise<SchedulerJobOutcome> => ({ error: "job did not finish within 300000ms", status: "timeout" });
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T09:00:00Z"),
      pauseFile, provider: "log", runJob, schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(store.updateCalls.map((c) => c.status)).toEqual(["running", "failed"]);
    expect(messaging.sent).toEqual([]);
  });

  it("a 'capacity' refusal (concurrency cap reached, nothing spawned) is recorded as 'skipped', never delivers", async () => {
    const pauseFile = tmpPauseFile();
    const created = new Date("2026-06-01T00:00:00Z");
    const store = new FakeStore([job({ createdAt: created })]);
    const messaging = fakeMessaging();
    const runJob = async (): Promise<SchedulerJobOutcome> => ({ error: "3 background jobs already running (limit 3)", status: "capacity" });
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T09:00:00Z"),
      pauseFile, provider: "log", runJob, schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(store.updateCalls.map((c) => c.status)).toEqual(["running", "skipped"]);
    expect(messaging.sent).toEqual([]);
  });

  it("OVERLAP GUARD: two ticks firing while a job's previous run is still in flight only ever runs it ONCE — the second is marked skipped, not double-run", async () => {
    const pauseFile = tmpPauseFile();
    const created = new Date("2026-06-01T00:00:00Z");

    // Deterministic gate: resolves the instant the tick marks job-1
    // "running" — the exact point the overlap guard has taken effect —
    // instead of racing a wall-clock setTimeout against real fs I/O.
    const markedRunning = Promise.withResolvers<void>();
    class GatedStore extends FakeStore {
      override updateExecutionResult(id: string, status: JobExecutionStatus, result?: string | null): void {
        super.updateExecutionResult(id, status, result);
        if (status === "running") markedRunning.resolve();
      }
    }
    const store = new GatedStore([job({ createdAt: created })]);
    const messaging = fakeMessaging();
    let runJobCalls = 0;
    const pending = Promise.withResolvers<SchedulerJobOutcome>();
    const runJob = async (): Promise<SchedulerJobOutcome> => {
      runJobCalls += 1;
      return pending.promise;
    };
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T09:00:00Z"),
      pauseFile, provider: "log", runJob, schedulerFile: "/unused", stdout, store
    });

    const firstTick = tick();
    // Wait for the FIRST tick to have actually marked job-1 "running"
    // (the overlap guard's `runningJobIds.add` happens right before that
    // write) before firing the second concurrent tick.
    await markedRunning;
    const secondTick = tick();
    // A CORRECTLY-guarded second tick needs no `runJob` resolution at all —
    // it hits the skip branch and settles on its own. Let it (or a short
    // timeout, if the guard were broken and it also called runJob) resolve
    // BEFORE releasing the first tick's `runJob` — otherwise the first
    // tick's fully-synchronous remaining work (fake store/messaging, no
    // real I/O) can run its `finally` cleanup and clear the guard via
    // microtasks alone before the second tick's own async pause-file read
    // (real fs I/O, a macrotask) ever gets a chance to check it.
    await Promise.race([secondTick, sleep(100)]);
    pending.resolve({ status: "success", text: "done" });
    await Promise.all([firstTick, secondTick]);

    expect(runJobCalls).toBe(1);
    expect(store.updateCalls.some((c) => c.status === "skipped" && (c.result ?? "").includes("previous run still in progress"))).toBe(true);
  });
});

describe("makeBriefingTick — day-rhythm morning briefing's PUSHED reconfirm question (S6)", () => {
  function fixtures() {
    const dir = mkdtempSync(join(tmpdir(), "muse-briefing-tick-"));
    return {
      answeredFile: join(dir, "reconfirm-answered.json"),
      channelOwnersFile: join(dir, "channel-owners.json"),
      configFile: join(dir, "config.json"),
      deliveryFile: join(dir, "reconfirm-delivery.json"),
      dir,
      objectivesFile: join(dir, "objectives.json"),
      sidecarFile: join(dir, "briefing-fired.json")
    };
  }

  function reconfirmableSlot(): UserModelSlot {
    return { category: "말투", confidence: 0.1, id: "pref-tone", kind: "preference", updatedAt: new Date("2026-05-01T00:00:00.000Z"), value: "간결한 답변" };
  }

  function fakeUserMemoryStore(slot: UserModelSlot | undefined): UserMemoryStore {
    const model: UserModel = {
      goals: slot?.kind === "goal" ? [slot] : [],
      preferences: slot?.kind === "preference" ? [slot] : [],
      schedule: slot?.kind === "schedule" ? [slot] : [],
      vetoes: slot?.kind === "veto" ? [slot] : []
    };
    const memory = { facts: {}, preferences: {}, recentTopics: [], updatedAt: new Date(), userId: "u", userModel: model };
    return {
      createFactIfAbsent: async () => ({ created: false, memory }),
      createPreferenceIfAbsent: async () => ({ created: false, memory }),
      deleteByUserId: async () => false,
      findByUserId: async () => memory,
      upsertFact: async () => ({ facts: {}, preferences: {}, recentTopics: [], updatedAt: new Date(), userId: "u" }),
      upsertPreference: async () => ({ facts: {}, preferences: {}, recentTopics: [], updatedAt: new Date(), userId: "u" })
    };
  }

  const NOW = new Date(2026, 6, 16, 9, 0, 0); // 09:00 local — inside an 08:00-10:00 morning window

  async function seedDayRhythm(configFile: string, morningHour = 8): Promise<void> {
    await writeDayRhythmConfig(configFile, { enabled: true, eveningHour: 18, morningHour });
  }

  it("appends the reconfirm question + reply instruction when day-rhythm fires with an eligible slot, and records the delivery", async () => {
    const f = fixtures();
    await seedDayRhythm(f.configFile);
    await addObjective(f.objectivesFile, {
      createdAt: "2026-07-01T00:00:00.000Z", id: "obj-1", kind: "until", spec: "watch the deploy", status: "active", userId: "stark"
    });
    const messaging = fakeMessaging();
    const registry = { has: (providerId: string) => providerId === "telegram", list: () => ["telegram"], send: messaging.send } as unknown as import("@muse/messaging").MessagingProviderRegistry;

    const tick = makeBriefingTick({
      calendarRegistry: new (await import("@muse/calendar")).CalendarProviderRegistry(),
      briefingCalendarLister: undefined,
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      destination: "555",
      env: { MUSE_BRIEFING_SIDECAR_FILE: f.sidecarFile, MUSE_USER_ID: "stark" },
      knowledgeEnrich: undefined,
      leadMinutes: 60,
      messagingRegistry: registry,
      now: () => NOW,
      objectivesFile: f.objectivesFile,
      provider: "telegram",
      reconfirmCardAnsweredFile: f.answeredFile,
      reconfirmCardDeliveryFile: f.deliveryFile,
      stdout: () => undefined,
      tasksFile: join(f.dir, "tasks.json"),
      userMemoryStore: fakeUserMemoryStore(reconfirmableSlot())
    });

    await tick();

    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0]?.text).toContain("[Muse가 확인하고 싶은 것]");
    expect(messaging.sent[0]?.text).toContain("말투");
    expect(messaging.sent[0]?.text).toContain("아니야");

    const { readReconfirmCardDelivery } = await import("@muse/stores");
    const delivery = await readReconfirmCardDelivery(f.deliveryFile);
    expect(delivery?.slotId).toBe("pref-tone");
  });

  it("byte-identical briefing when no reconfirmable slot exists", async () => {
    const f = fixtures();
    await seedDayRhythm(f.configFile);
    await addObjective(f.objectivesFile, {
      createdAt: "2026-07-01T00:00:00.000Z", id: "obj-1", kind: "until", spec: "watch the deploy", status: "active", userId: "stark"
    });
    const messaging = fakeMessaging();
    const registry = { has: (providerId: string) => providerId === "telegram", list: () => ["telegram"], send: messaging.send } as unknown as import("@muse/messaging").MessagingProviderRegistry;

    const tick = makeBriefingTick({
      calendarRegistry: new (await import("@muse/calendar")).CalendarProviderRegistry(),
      briefingCalendarLister: undefined,
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      destination: "555",
      env: { MUSE_BRIEFING_SIDECAR_FILE: f.sidecarFile, MUSE_USER_ID: "stark" },
      knowledgeEnrich: undefined,
      leadMinutes: 60,
      messagingRegistry: registry,
      now: () => NOW,
      objectivesFile: f.objectivesFile,
      provider: "telegram",
      reconfirmCardAnsweredFile: f.answeredFile,
      reconfirmCardDeliveryFile: f.deliveryFile,
      stdout: () => undefined,
      tasksFile: join(f.dir, "tasks.json"),
      userMemoryStore: fakeUserMemoryStore(undefined)
    });

    await tick();

    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0]?.text).not.toContain("Muse가 확인하고 싶은 것");
  });

  it("byte-identical briefing when the day is already answered (shared gate with the Home card)", async () => {
    const f = fixtures();
    await seedDayRhythm(f.configFile);
    await addObjective(f.objectivesFile, {
      createdAt: "2026-07-01T00:00:00.000Z", id: "obj-1", kind: "until", spec: "watch the deploy", status: "active", userId: "stark"
    });
    const { markReconfirmCardAnswered } = await import("@muse/stores");
    await markReconfirmCardAnswered(f.answeredFile, NOW);
    const messaging = fakeMessaging();
    const registry = { has: (providerId: string) => providerId === "telegram", list: () => ["telegram"], send: messaging.send } as unknown as import("@muse/messaging").MessagingProviderRegistry;

    const tick = makeBriefingTick({
      calendarRegistry: new (await import("@muse/calendar")).CalendarProviderRegistry(),
      briefingCalendarLister: undefined,
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      destination: "555",
      env: { MUSE_BRIEFING_SIDECAR_FILE: f.sidecarFile, MUSE_USER_ID: "stark" },
      knowledgeEnrich: undefined,
      leadMinutes: 60,
      messagingRegistry: registry,
      now: () => NOW,
      objectivesFile: f.objectivesFile,
      provider: "telegram",
      reconfirmCardAnsweredFile: f.answeredFile,
      reconfirmCardDeliveryFile: f.deliveryFile,
      stdout: () => undefined,
      tasksFile: join(f.dir, "tasks.json"),
      userMemoryStore: fakeUserMemoryStore(reconfirmableSlot())
    });

    await tick();

    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0]?.text).not.toContain("Muse가 확인하고 싶은 것");
  });

  it("the legacy MUSE_BRIEFING_ENABLED env path (not day-rhythm-driven) never appends the reconfirm addendum, even with an eligible slot", async () => {
    const f = fixtures();
    // dayRhythm left disabled — envEnabled drives this tick instead.
    await addObjective(f.objectivesFile, {
      createdAt: "2026-07-01T00:00:00.000Z", id: "obj-1", kind: "until", spec: "watch the deploy", status: "active", userId: "stark"
    });
    const messaging = fakeMessaging();
    const registry = { has: (providerId: string) => providerId === "log", list: () => ["log"], send: messaging.send } as unknown as import("@muse/messaging").MessagingProviderRegistry;

    const tick = makeBriefingTick({
      calendarRegistry: new (await import("@muse/calendar")).CalendarProviderRegistry(),
      briefingCalendarLister: undefined,
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      destination: "@me",
      env: { MUSE_BRIEFING_ENABLED: "true", MUSE_BRIEFING_SIDECAR_FILE: f.sidecarFile, MUSE_USER_ID: "stark" },
      knowledgeEnrich: undefined,
      leadMinutes: 60,
      messagingRegistry: registry,
      now: () => NOW,
      objectivesFile: f.objectivesFile,
      provider: "log",
      reconfirmCardAnsweredFile: f.answeredFile,
      reconfirmCardDeliveryFile: f.deliveryFile,
      stdout: () => undefined,
      tasksFile: join(f.dir, "tasks.json"),
      userMemoryStore: fakeUserMemoryStore(reconfirmableSlot())
    });

    await tick();

    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0]?.text).not.toContain("Muse가 확인하고 싶은 것");
  });

  it("no dayRhythm/env enabled at all → no send, reconfirm resolver never consulted", async () => {
    const f = fixtures();
    await addObjective(f.objectivesFile, {
      createdAt: "2026-07-01T00:00:00.000Z", id: "obj-1", kind: "until", spec: "watch the deploy", status: "active", userId: "stark"
    });
    const messaging = fakeMessaging();
    const registry = { has: () => false, list: () => [], send: messaging.send } as unknown as import("@muse/messaging").MessagingProviderRegistry;
    let storeCalled = false;
    const store = fakeUserMemoryStore(reconfirmableSlot());

    const tick = makeBriefingTick({
      calendarRegistry: new (await import("@muse/calendar")).CalendarProviderRegistry(),
      briefingCalendarLister: undefined,
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      destination: "@me",
      env: { MUSE_BRIEFING_SIDECAR_FILE: f.sidecarFile, MUSE_USER_ID: "stark" },
      knowledgeEnrich: undefined,
      leadMinutes: 60,
      messagingRegistry: registry,
      now: () => NOW,
      objectivesFile: f.objectivesFile,
      provider: "log",
      reconfirmCardAnsweredFile: f.answeredFile,
      reconfirmCardDeliveryFile: f.deliveryFile,
      stdout: () => undefined,
      tasksFile: join(f.dir, "tasks.json"),
      userMemoryStore: {
        ...store,
        findByUserId: async () => {
          storeCalled = true;
          return store.findByUserId("stark");
        }
      }
    });

    await tick();

    expect(messaging.sent).toHaveLength(0);
    expect(storeCalled).toBe(false);
  });
});

describe("makeBriefingTick — shared CLI route contract", () => {
  const NOW = new Date(2026, 6, 16, 9, 0, 0);

  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "muse-briefing-route-"));
    return {
      answeredFile: join(dir, "reconfirm-answered.json"),
      channelOwnersFile: join(dir, "channel-owners.json"),
      configFile: join(dir, "config.json"),
      deliveryFile: join(dir, "reconfirm-delivery.json"),
      dir,
      objectivesFile: join(dir, "objectives.json"),
      sidecarFile: join(dir, "briefing-fired.json"),
      stdout: [] as string[]
    };
  }

  function routeRegistry(...providerIds: readonly string[]): { readonly registry: MessagingProviderRegistry; readonly sent: Array<{ readonly destination: string; readonly providerId: string; readonly text: string }> } {
    const sent: Array<{ readonly destination: string; readonly providerId: string; readonly text: string }> = [];
    const registry = new MessagingProviderRegistry(providerIds.map((providerId) => ({
      describe: () => ({ description: providerId, displayName: providerId, id: providerId }),
      id: providerId,
      send: async (message: { readonly destination: string; readonly text: string }) => {
        sent.push({ destination: message.destination, providerId, text: message.text });
        return { destination: message.destination, messageId: `${providerId}-briefing`, providerId };
      }
    })));
    return { registry, sent };
  }

  function emptyUserMemoryStore(): UserMemoryStore {
    const memory = {
      facts: {},
      preferences: {},
      recentTopics: [],
      updatedAt: new Date(),
      userId: "stark",
      userModel: { goals: [], preferences: [], schedule: [], vetoes: [] }
    };
    return {
      createFactIfAbsent: async () => ({ created: false, memory }),
      createPreferenceIfAbsent: async () => ({ created: false, memory }),
      deleteByUserId: async () => false,
      findByUserId: async () => memory,
      upsertFact: async () => memory,
      upsertPreference: async () => memory
    };
  }

  async function seedBriefing(f: ReturnType<typeof fixture>, dayRhythm = false): Promise<void> {
    if (dayRhythm) await writeDayRhythmConfig(f.configFile, { enabled: true, eveningHour: 18, morningHour: 8 });
    await addObjective(f.objectivesFile, {
      createdAt: "2026-07-01T00:00:00.000Z", id: "route-objective", kind: "until", spec: "watch the route", status: "active", userId: "stark"
    });
  }

  function tickFor(
    f: ReturnType<typeof fixture>,
    options: {
      readonly claim?: () => boolean;
      readonly destination: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly messagingRegistry: MessagingProviderRegistry;
      readonly provider: string;
    }
  ): ReturnType<typeof makeBriefingTick> {
    return makeBriefingTick({
      calendarRegistry: new CalendarProviderRegistry(),
      briefingCalendarLister: undefined,
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      destination: options.destination,
      env: { MUSE_BRIEFING_SIDECAR_FILE: f.sidecarFile, MUSE_USER_ID: "stark", ...options.env },
      knowledgeEnrich: undefined,
      leadMinutes: 60,
      messagingRegistry: options.messagingRegistry,
      now: () => NOW,
      objectivesFile: f.objectivesFile,
      provider: options.provider,
      reconfirmCardAnsweredFile: f.answeredFile,
      reconfirmCardDeliveryFile: f.deliveryFile,
      stdout: (message) => f.stdout.push(message),
      tasksFile: join(f.dir, "tasks.json"),
      userMemoryStore: emptyUserMemoryStore()
    });
  }

  it("preserves the legacy explicit provider and destination route", async () => {
    const f = fixture();
    await seedBriefing(f, true);
    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: { discord: "paired" }, version: 1 }));
    const { registry, sent } = routeRegistry("telegram", "discord");
    await tickFor(f, {
      destination: "explicit",
      env: { MUSE_BRIEFING_ENABLED: "true" },
      messagingRegistry: registry,
      provider: "telegram"
    })();
    expect(sent.map((message) => [message.providerId, message.destination])).toEqual([["telegram", "explicit"]]);
  });

  it("refreshes a day-rhythm paired route from A to B across resident ticks", async () => {
    const f = fixture();
    await seedBriefing(f, true);
    const { registry, sent } = routeRegistry("telegram", "discord", "log");
    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: { telegram: "A" }, version: 1 }));
    const tick = tickFor(f, { destination: "@me", messagingRegistry: registry, provider: "log" });
    await tick();
    rmSync(f.sidecarFile);
    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: { discord: "B" }, version: 1 }));
    await tick();
    expect(sent.map((message) => [message.providerId, message.destination])).toEqual([["telegram", "A"], ["discord", "B"]]);
  });

  it.each([
    ["no owner", { owners: {} }, { destination: "@me", provider: "log" }, {}, "day rhythm on but no channel paired", "unconfigured"],
    ["ambiguous", { owners: { discord: "B", telegram: "A" } }, { destination: "@me", provider: "log" }, {}, "route-ambiguous", "unconfigured"],
    ["malformed", "not-json", { destination: "@me", provider: "log" }, {}, "route-unconfigured", "unconfigured"],
    ["unregistered", { owners: {} }, { destination: "555", provider: "telegram" }, { MUSE_BRIEFING_ENABLED: "true" }, "route-unconfigured", "unconfigured"],
    ["incomplete", { owners: {} }, { destination: "", provider: "telegram" }, { MUSE_BRIEFING_ENABLED: "true" }, "route-unconfigured", "unconfigured"],
    ["local-only", { owners: {} }, { destination: "555", provider: "telegram" }, { MUSE_BRIEFING_ENABLED: "true", MUSE_LOCAL_ONLY: "true" }, "route-blocked-local-only", "blocked-local-only"],
  ] as const)("fails closed for %s before claim, core, provider, or effects", async (_label, owners, route, env, output, _routeStatus) => {
    const f = fixture();
    const dayRhythm = route.provider === "log";
    await seedBriefing(f, dayRhythm);
    writeFileSync(f.channelOwnersFile, typeof owners === "string" ? owners : JSON.stringify({ ...owners, version: 1 }));
    const { registry, sent } = _label === "unregistered"
      ? routeRegistry("discord")
      : routeRegistry("telegram", "discord");
    const claim = vi.fn(() => true);
    const core = vi.spyOn(domainTools, "runDueSituationalBriefing");
    try {
      const result = await tickFor(f, { claim, destination: route.destination, env, messagingRegistry: registry, provider: route.provider })(claim);
      expect(result.status).toBe("not-ready");
      expect(result).toMatchObject({ reason: "unconfigured" });
      expect(claim).not.toHaveBeenCalled();
      expect(core).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
      expect(existsSync(f.sidecarFile)).toBe(false);
      expect(existsSync(f.deliveryFile)).toBe(false);
      expect(f.stdout.join(" ")).toContain(output);
    } finally {
      core.mockRestore();
    }
  });

  it("fails closed and emits no raw resolver error", async () => {
    const f = fixture();
    await seedBriefing(f);
    const sent: Array<unknown> = [];
    const registry = { has: () => { throw new Error("private route secret"); }, send: async () => { sent.push(true); return {}; } } as unknown as MessagingProviderRegistry;
    const claim = vi.fn(() => true);
    const result = await tickFor(f, { destination: "555", env: { MUSE_BRIEFING_ENABLED: "true" }, messagingRegistry: registry, provider: "telegram" })(claim);
    expect(result).toMatchObject({ reason: "unconfigured", status: "not-ready" });
    expect(claim).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(f.stdout.join(" ")).toContain("briefing: skipped (route-unavailable)");
    expect(f.stdout.join(" ")).not.toContain("private route secret");
  });
});

describe("makeDailyBriefTick — muse setup briefing's fixed-time daily brief", () => {
  function tmpFiles(): { readonly configFile: string; readonly sidecarFile: string } {
    const dir = mkdtempSync(join(tmpdir(), "muse-daily-brief-tick-"));
    return { configFile: join(dir, "daemon.json"), sidecarFile: join(dir, "daily-brief-fired.json") };
  }

  function writeConfig(file: string, dailyBrief: { enabled: boolean; time: string } | undefined): void {
    writeFileSync(file, JSON.stringify({ dailyBrief, destination: "@me", provider: "log" }), "utf8");
  }

  function fakeMessaging(fail = false) {
    const sent: Array<{ providerId: string; destination: string; text: string }> = [];
    return {
      sent,
      send: async (providerId: string, message: { destination: string; text: string }) => {
        if (fail) throw new Error("send failed (simulated)");
        sent.push({ destination: message.destination, providerId, text: message.text });
        return { providerId, status: "sent" as const };
      }
    };
  }

  it("disabled config → cheap no-op: no compose call, no send, no sidecar write", async () => {
    const { configFile, sidecarFile } = tmpFiles();
    writeConfig(configFile, { enabled: false, time: "08:30" });
    const messaging = fakeMessaging();
    let composed = false;
    const tick = makeDailyBriefTick({
      composeBrief: async () => { composed = true; return "brief text"; },
      configFile,
      destination: "@me",
      env: {},
      messagingRegistry: messaging as never,
      now: () => new Date("2026-06-04T09:00:00"),
      provider: "log",
      sidecarFile,
      stdout: () => undefined
    });
    await tick();
    expect(composed).toBe(false);
    expect(messaging.sent).toHaveLength(0);
    expect(() => readFileSync(sidecarFile, "utf8")).toThrow();
  });

  it("no config file at all (fresh install) → no-op", async () => {
    const { configFile, sidecarFile } = tmpFiles(); // configFile never written
    const messaging = fakeMessaging();
    const tick = makeDailyBriefTick({
      configFile,
      destination: "@me",
      env: {},
      messagingRegistry: messaging as never,
      now: () => new Date("2026-06-04T09:00:00"),
      provider: "log",
      sidecarFile,
      stdout: () => undefined
    });
    await tick();
    expect(messaging.sent).toHaveLength(0);
  });

  it("enabled + past the target time + never fired → delivers and marks the sidecar", async () => {
    const { configFile, sidecarFile } = tmpFiles();
    writeConfig(configFile, { enabled: true, time: "08:30" });
    const messaging = fakeMessaging();
    const tick = makeDailyBriefTick({
      composeBrief: async () => "your deterministic brief",
      configFile,
      destination: "@me",
      env: {},
      messagingRegistry: messaging as never,
      now: () => new Date("2026-06-04T09:00:00"),
      provider: "log",
      sidecarFile,
      stdout: () => undefined
    });
    await tick();
    expect(messaging.sent).toEqual([{ destination: "@me", providerId: "log", text: "your deterministic brief" }]);
    expect(JSON.parse(readFileSync(sidecarFile, "utf8"))).toEqual({ lastFired: new Date("2026-06-04T09:00:00").toISOString() });
  });

  it("before the target time → does not fire", async () => {
    const { configFile, sidecarFile } = tmpFiles();
    writeConfig(configFile, { enabled: true, time: "08:30" });
    const messaging = fakeMessaging();
    const tick = makeDailyBriefTick({
      configFile,
      destination: "@me",
      env: {},
      messagingRegistry: messaging as never,
      now: () => new Date("2026-06-04T08:00:00"),
      provider: "log",
      sidecarFile,
      stdout: () => undefined
    });
    await tick();
    expect(messaging.sent).toHaveLength(0);
  });

  it("two tick runs the same day after the sidecar mark → sends exactly once (restart-safe)", async () => {
    const { configFile, sidecarFile } = tmpFiles();
    writeConfig(configFile, { enabled: true, time: "08:30" });
    const messaging = fakeMessaging();
    const makeTick = () => makeDailyBriefTick({
      composeBrief: async () => "brief",
      configFile,
      destination: "@me",
      env: {},
      messagingRegistry: messaging as never,
      now: () => new Date("2026-06-04T09:00:00"),
      provider: "log",
      sidecarFile,
      stdout: () => undefined
    });
    await makeTick()(); // first tick (simulates the daemon restarting and creating a fresh tick closure)
    await makeTick()(); // second tick, same day
    expect(messaging.sent).toHaveLength(1);
  });

  it("marked fired yesterday → fires again today (crosses midnight correctly)", async () => {
    const { configFile, sidecarFile } = tmpFiles();
    writeConfig(configFile, { enabled: true, time: "08:30" });
    writeFileSync(sidecarFile, JSON.stringify({ lastFired: "2026-06-03T08:31:00.000Z" }), "utf8");
    const messaging = fakeMessaging();
    const tick = makeDailyBriefTick({
      composeBrief: async () => "brief",
      configFile,
      destination: "@me",
      env: {},
      messagingRegistry: messaging as never,
      now: () => new Date("2026-06-04T09:00:00"),
      provider: "log",
      sidecarFile,
      stdout: () => undefined
    });
    await tick();
    expect(messaging.sent).toHaveLength(1);
  });

  it("a daemon that was off past the target time fires on its NEXT tick, same day, never back-fills a missed day", async () => {
    const { configFile, sidecarFile } = tmpFiles();
    writeConfig(configFile, { enabled: true, time: "08:30" });
    // Last fired two days ago — the daemon was off yesterday and today
    // until just now. It must fire ONCE (today), not once per missed day.
    writeFileSync(sidecarFile, JSON.stringify({ lastFired: "2026-06-02T08:31:00.000Z" }), "utf8");
    const messaging = fakeMessaging();
    const tick = makeDailyBriefTick({
      composeBrief: async () => "brief",
      configFile,
      destination: "@me",
      env: {},
      messagingRegistry: messaging as never,
      now: () => new Date("2026-06-04T14:00:00"),
      provider: "log",
      sidecarFile,
      stdout: () => undefined
    });
    await tick();
    expect(messaging.sent).toHaveLength(1);
    await tick(); // a second tick moments later must not re-fire
    expect(messaging.sent).toHaveLength(1);
  });

  it("send failure is fail-soft: no sidecar write, so the NEXT tick retries (never marked sent without delivery)", async () => {
    const { configFile, sidecarFile } = tmpFiles();
    writeConfig(configFile, { enabled: true, time: "08:30" });
    const failing = fakeMessaging(true);
    const stdoutLines: string[] = [];
    const tick = makeDailyBriefTick({
      composeBrief: async () => "brief",
      configFile,
      destination: "@me",
      env: {},
      messagingRegistry: failing as never,
      now: () => new Date("2026-06-04T09:00:00"),
      provider: "log",
      sidecarFile,
      stdout: (m) => stdoutLines.push(m)
    });
    await tick();
    expect(() => readFileSync(sidecarFile, "utf8")).toThrow();
    expect(stdoutLines.join("")).toMatch(/send failed/);

    // The daemon stays up — a retry on the next tick, now with a working
    // provider, succeeds and marks the sidecar.
    const working = fakeMessaging(false);
    const retryTick = makeDailyBriefTick({
      composeBrief: async () => "brief",
      configFile,
      destination: "@me",
      env: {},
      messagingRegistry: working as never,
      now: () => new Date("2026-06-04T09:05:00"),
      provider: "log",
      sidecarFile,
      stdout: () => undefined
    });
    await retryTick();
    expect(working.sent).toHaveLength(1);
  });

  it("an invalid time in the config is a safe no-op (never throws, never sends)", async () => {
    const { configFile, sidecarFile } = tmpFiles();
    writeConfig(configFile, { enabled: true, time: "25:00" });
    const messaging = fakeMessaging();
    const tick = makeDailyBriefTick({
      composeBrief: async () => "brief",
      configFile,
      destination: "@me",
      env: {},
      messagingRegistry: messaging as never,
      now: () => new Date("2026-06-04T09:00:00"),
      provider: "log",
      sidecarFile,
      stdout: () => undefined
    });
    await expect(tick()).resolves.toBeUndefined();
    expect(messaging.sent).toHaveLength(0);
  });

  it("the config is read LIVE every tick — a mid-run enable takes effect without a restart", async () => {
    const { configFile, sidecarFile } = tmpFiles();
    writeConfig(configFile, { enabled: false, time: "08:30" });
    const messaging = fakeMessaging();
    const tick = makeDailyBriefTick({
      composeBrief: async () => "brief",
      configFile,
      destination: "@me",
      env: {},
      messagingRegistry: messaging as never,
      now: () => new Date("2026-06-04T09:00:00"),
      provider: "log",
      sidecarFile,
      stdout: () => undefined
    });
    await tick();
    expect(messaging.sent).toHaveLength(0);

    // Simulates `muse setup briefing` enabling it while the daemon keeps running.
    writeConfig(configFile, { enabled: true, time: "08:30" });
    await tick();
    expect(messaging.sent).toHaveLength(1);
  });

  it("the default composer has NO model provider in its dependency shape — deterministic, no LLM in the loop", async () => {
    // Real default composer (buildLocalTodayText), no `composeBrief` override:
    // it must succeed from on-disk sources alone, with zero model config.
    const { configFile, sidecarFile } = tmpFiles();
    writeConfig(configFile, { enabled: true, time: "08:30" });
    const messaging = fakeMessaging();
    const dir = mkdtempSync(join(tmpdir(), "muse-daily-brief-sources-"));
    const tick = makeDailyBriefTick({
      configFile,
      destination: "@me",
      env: {
        MUSE_NOTES_DIR: join(dir, "notes"),
        MUSE_TASKS_FILE: join(dir, "tasks.json")
        // deliberately no MUSE_MODEL / provider keys of any kind
      } as NodeJS.ProcessEnv,
      messagingRegistry: messaging as never,
      now: () => new Date("2026-06-04T09:00:00"),
      provider: "log",
      sidecarFile,
      stdout: () => undefined
    });
    await tick();
    expect(messaging.sent).toHaveLength(1);
    expect(typeof messaging.sent[0]!.text).toBe("string");
  });
});

describe("R3-4 AC3 exemption pin — the daily brief has no quiet-hours field at all", () => {
  it("MakeDailyBriefTickDeps has no quietHours field (compile-time pin, checked by `tsc -b`)", () => {
    // If this stops erroring, someone wired the persisted quiet-hours setting
    // into the fixed-time daily brief — that breaks the EXEMPT invariant
    // (a user-scheduled digest is never gated by ambient-chatter suppression).
    const pin: MakeDailyBriefTickDeps = {
      configFile: "x",
      destination: "@me",
      // @ts-expect-error — quietHours is not a valid MakeDailyBriefTickDeps field.
      quietHours: { endHour: 8, startHour: 23 },
      env: {} as NodeJS.ProcessEnv,
      messagingRegistry: {} as never,
      provider: "log",
      sidecarFile: "x",
      stdout: () => undefined
    };
    expect(pin).toBeDefined();
  });
});
