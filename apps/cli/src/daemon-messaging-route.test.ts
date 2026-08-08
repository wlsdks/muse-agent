import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CalendarProviderRegistry } from "@muse/calendar";
import { MessagingProviderRegistry, type OutboundMessage } from "@muse/messaging";
import { writeDayRhythmConfig } from "@muse/autoconfigure";
import { describe, expect, it, vi } from "vitest";

import { resolveCliMessagingRoute } from "./daemon-messaging-route.js";
import { makeProactiveTick } from "./daemon-delivery-ticks.js";
import { makeDigestFlushTick, type MakeDigestFlushTickDeps } from "./daemon-selflearn-ticks.js";

function fixtureFiles(): {
  readonly channelOwnersFile: string;
  readonly configFile: string;
  readonly dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "muse-cli-route-"));
  return {
    channelOwnersFile: join(dir, "channel-owners.json"),
    configFile: join(dir, "config.json"),
    dir
  };
}

function provider(id: string, sent: OutboundMessage[]): { readonly id: string; readonly describe: () => { readonly description: string; readonly displayName: string; readonly id: string }; readonly send: (message: OutboundMessage) => Promise<{ readonly destination: string; readonly messageId: string; readonly providerId: string }> } {
  return {
    describe: () => ({ description: id, displayName: id, id }),
    id,
    send: async (message) => {
      sent.push(message);
      return { destination: message.destination, messageId: `${id}-message`, providerId: id };
    }
  };
}

function registryFor(...ids: readonly string[]): { readonly registry: MessagingProviderRegistry; readonly sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return { registry: new MessagingProviderRegistry(ids.map((id) => provider(id, sent))), sent };
}

async function seedDayRhythm(configFile: string, hour = 18): Promise<void> {
  await writeDayRhythmConfig(configFile, { enabled: true, eveningHour: hour, morningHour: 8 });
}

describe("resolveCliMessagingRoute", () => {
  it("keeps the CLI's already-resolved flag/env/config route authoritative", () => {
    const { registry } = registryFor("telegram", "discord");
    expect(resolveCliMessagingRoute({
      channelOwnersFile: "/unused",
      dayRhythmEnabled: false,
      destination: "config-destination",
      env: { MUSE_PROACTIVE_DESTINATION: "stale-env-destination", MUSE_PROACTIVE_PROVIDER: "telegram" },
      messagingRegistry: registry,
      provider: "discord"
    })).toMatchObject({ destination: "config-destination", providerId: "discord", status: "resolved" });
  });

  it.each([
    ["flag", "discord", "flag-destination"],
    ["env", "telegram", "env-destination"],
    ["config", "discord", "config-destination"],
    ["default", "log", "@me"]
  ] as const)("accepts the already selected %s value without stale ambient env replacement", (_source, providerId, destination) => {
    const { registry } = registryFor("log", "telegram", "discord");
    expect(resolveCliMessagingRoute({
      channelOwnersFile: "/unused",
      dayRhythmEnabled: false,
      destination,
      env: { MUSE_PROACTIVE_DESTINATION: "stale", MUSE_PROACTIVE_PROVIDER: "stale-provider" },
      messagingRegistry: registry,
      provider: providerId
    })).toMatchObject({ destination, providerId, source: "explicit-config", status: "resolved" });
  });

  it("refreshes the day-rhythm paired-owner route without reconstructing the adapter", async () => {
    const f = fixtureFiles();
    const { registry } = registryFor("telegram", "discord");
    await writeDayRhythmConfig(f.configFile, { enabled: true, eveningHour: 18, morningHour: 8 });
    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: { telegram: "A" }, version: 1 }));
    const first = resolveCliMessagingRoute({
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmEnabled: true,
      destination: "@me",
      env: { MUSE_PROACTIVE_PROVIDER: "log", MUSE_PROACTIVE_DESTINATION: "@me" },
      messagingRegistry: registry,
      provider: "log"
    });
    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: { discord: "B" }, version: 1 }));
    const second = resolveCliMessagingRoute({
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmEnabled: true,
      destination: "@me",
      env: { MUSE_PROACTIVE_PROVIDER: "log", MUSE_PROACTIVE_DESTINATION: "@me" },
      messagingRegistry: registry,
      provider: "log"
    });
    expect(first).toMatchObject({ destination: "A", providerId: "telegram", status: "resolved" });
    expect(second).toMatchObject({ destination: "B", providerId: "discord", status: "resolved" });
  });

  it.each([
    ["ambiguous", { owners: { discord: "B", telegram: "A" }, version: 1 }, "ambiguous"],
    ["no owner", { owners: {}, version: 1 }, "unconfigured"],
    ["malformed", "not-json", "unconfigured"]
  ] as const)("fails closed for %s paired routes", (_label, contents, status) => {
    const f = fixtureFiles();
    const { registry } = registryFor("telegram", "discord");
    writeFileSync(f.channelOwnersFile, typeof contents === "string" ? contents : JSON.stringify(contents));
    expect(resolveCliMessagingRoute({
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmEnabled: true,
      destination: "@me",
      env: {},
      messagingRegistry: registry,
      provider: "log"
    }).status).toBe(status);
  });

  it("preserves local-only, incomplete, and unregistered route failures", () => {
    const f = fixtureFiles();
    const { registry } = registryFor("telegram");
    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: { telegram: "A" }, version: 1 }));
    expect(resolveCliMessagingRoute({
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmEnabled: true,
      destination: "@me",
      env: { MUSE_LOCAL_ONLY: "true" },
      messagingRegistry: registry,
      provider: "log"
    }).status).toBe("blocked-local-only");
    expect(resolveCliMessagingRoute({
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmEnabled: false,
      destination: "",
      env: {},
      messagingRegistry: registry,
      provider: "telegram"
    }).status).toBe("unconfigured");
    expect(resolveCliMessagingRoute({
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmEnabled: false,
      destination: "A",
      env: {},
      messagingRegistry: registry,
      provider: "discord"
    }).status).toBe("unconfigured");
  });

  it("rejects a valid owner alongside a malformed pairable owner", () => {
    const f = fixtureFiles();
    const { registry } = registryFor("telegram", "discord");
    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: { discord: 42, telegram: "A" }, version: 1 }));
    expect(resolveCliMessagingRoute({
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmEnabled: true,
      destination: "@me",
      env: {},
      messagingRegistry: registry,
      provider: "log"
    })).toMatchObject({ reason: "malformed-paired-route", status: "unconfigured" });
  });
});

describe("CLI delivery ticks use the live route immediately before delivery", () => {
  it("proactive delivery revalidates the explicit route every tick and skips before provider effects on invalid or throwing routes", async () => {
    const f = fixtureFiles();
    const { registry, sent } = registryFor("telegram", "discord");
    const tick = makeProactiveTick({
      calendarRegistry: new CalendarProviderRegistry(),
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      dailyCap: 0,
      destination: "@me",
      effectFile: join(f.dir, "effects.json"),
      env: {},
      historyFile: join(f.dir, "history.json"),
      leadMinutes: 10,
      messagingRegistry: registry,
      provider: "telegram",
      quietHours: undefined,
      sidecarFile: join(f.dir, "sidecar.json"),
      tasksFile: join(f.dir, "tasks.json"),
      trustLedgerFile: join(f.dir, "trust.json"),
      stdout: () => undefined
    });
    writeFileSync(join(f.dir, "tasks.json"), JSON.stringify({ tasks: [{ createdAt: "2026-01-01T00:00:00Z", dueAt: new Date(Date.now() + 300_000).toISOString(), id: "task-a", status: "open", title: "A" }] }));
    await tick();
    registry.unregister("telegram");
    writeFileSync(join(f.dir, "tasks.json"), JSON.stringify({ tasks: [{ createdAt: "2026-01-01T00:00:00Z", dueAt: new Date(Date.now() + 300_000).toISOString(), id: "task-b", status: "open", title: "B" }] }));
    await tick();
    expect(sent.map((message) => message.destination)).toEqual(["@me"]);

    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: {}, version: 1 }));
    writeFileSync(join(f.dir, "tasks.json"), JSON.stringify({ tasks: [{ createdAt: "2026-01-01T00:00:00Z", dueAt: new Date(Date.now() + 300_000).toISOString(), id: "task-c", status: "open", title: "C" }] }));
    await tick();
    expect(sent).toHaveLength(1);
    expect(existsSync(join(f.dir, "effects.json"))).toBe(true);

    const throwingRegistry = { has: () => { throw new Error("private route details"); } } as unknown as MessagingProviderRegistry;
    const throwingOutput: string[] = [];
    const throwingTick = makeProactiveTick({
      calendarRegistry: new CalendarProviderRegistry(),
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      dailyCap: 0,
      destination: "@me",
      effectFile: join(f.dir, "throwing-effects.json"),
      env: {},
      historyFile: join(f.dir, "throwing-history.json"),
      leadMinutes: 10,
      messagingRegistry: throwingRegistry,
      provider: "log",
      quietHours: undefined,
      sidecarFile: join(f.dir, "throwing-sidecar.json"),
      tasksFile: join(f.dir, "tasks.json"),
      trustLedgerFile: join(f.dir, "throwing-trust.json"),
      stdout: (message) => throwingOutput.push(message)
    });
    await throwingTick();
    expect(existsSync(join(f.dir, "throwing-effects.json"))).toBe(false);
    expect(existsSync(join(f.dir, "throwing-history.json"))).toBe(false);
    expect(existsSync(join(f.dir, "throwing-sidecar.json"))).toBe(false);
    expect(existsSync(join(f.dir, "throwing-trust.json"))).toBe(false);
    expect(throwingOutput.join("")).not.toContain("private route details");
  });

  it("proactive delivery fails closed for a local-only remote route before writing effects", async () => {
    const f = fixtureFiles();
    const { registry, sent } = registryFor("telegram");
    const tick = makeProactiveTick({
      calendarRegistry: new CalendarProviderRegistry(),
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      dailyCap: 0,
      destination: "@me",
      effectFile: join(f.dir, "local-only-effects.json"),
      env: { MUSE_LOCAL_ONLY: "true" },
      historyFile: join(f.dir, "local-only-history.json"),
      leadMinutes: 10,
      messagingRegistry: registry,
      provider: "telegram",
      quietHours: undefined,
      sidecarFile: join(f.dir, "local-only-sidecar.json"),
      tasksFile: join(f.dir, "local-only-tasks.json"),
      trustLedgerFile: join(f.dir, "local-only-trust.json"),
      stdout: () => undefined
    });
    writeFileSync(join(f.dir, "local-only-tasks.json"), JSON.stringify({ tasks: [{ createdAt: "2026-01-01T00:00:00Z", dueAt: new Date(Date.now() + 300_000).toISOString(), id: "local-only-task", status: "open", title: "Blocked" }] }));

    await tick();

    expect(sent).toHaveLength(0);
    expect(existsSync(join(f.dir, "local-only-effects.json"))).toBe(false);
    expect(existsSync(join(f.dir, "local-only-history.json"))).toBe(false);
    expect(existsSync(join(f.dir, "local-only-sidecar.json"))).toBe(false);
  });

  it("proactive delivery refreshes a paired route from A to B on resident ticks", async () => {
    const f = fixtureFiles();
    const telegramSent: OutboundMessage[] = [];
    const discordSent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([
      provider("telegram", telegramSent),
      provider("discord", discordSent)
    ]);
    await seedDayRhythm(f.configFile);
    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: { telegram: "A" }, version: 1 }));
    const tick = makeProactiveTick({
      calendarRegistry: new CalendarProviderRegistry(),
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      dailyCap: 0,
      destination: "@me",
      effectFile: join(f.dir, "paired-effects.json"),
      env: {},
      historyFile: join(f.dir, "paired-history.json"),
      leadMinutes: 10,
      messagingRegistry: registry,
      provider: "log",
      quietHours: undefined,
      sidecarFile: join(f.dir, "paired-sidecar.json"),
      tasksFile: join(f.dir, "paired-tasks.json"),
      trustLedgerFile: join(f.dir, "paired-trust.json"),
      stdout: () => undefined
    });

    writeFileSync(join(f.dir, "paired-tasks.json"), JSON.stringify({ tasks: [{ createdAt: "2026-01-01T00:00:00Z", dueAt: new Date(Date.now() + 300_000).toISOString(), id: "paired-task-a", status: "open", title: "A" }] }));
    await tick();
    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: { discord: "B" }, version: 1 }));
    writeFileSync(join(f.dir, "paired-tasks.json"), JSON.stringify({ tasks: [{ createdAt: "2026-01-01T00:00:00Z", dueAt: new Date(Date.now() + 300_000).toISOString(), id: "paired-task-b", status: "open", title: "B" }] }));
    await tick();

    expect(telegramSent.map((message) => message.destination)).toEqual(["A"]);
    expect(discordSent.map((message) => message.destination)).toEqual(["B"]);
  });

  it("digest refreshes A to B, preserves hour gating, and makes no claim/core call for invalid routes", async () => {
    const f = fixtureFiles();
    const { registry, sent } = registryFor("telegram", "discord");
    await seedDayRhythm(f.configFile, 18);
    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: { telegram: "A" }, version: 1 }));
    const digestFlush = vi.fn(async (options: Parameters<NonNullable<MakeDigestFlushTickDeps["digestFlush"]>>[0]) => {
      expect(options.claim?.()).toBe(true);
      await options.registry.send(options.providerId, { destination: options.destination, text: options.destination });
      return { errors: [], itemCount: 1, outcome: "sent" as const };
    });
    const makeTick = (): ReturnType<typeof makeDigestFlushTick> => makeDigestFlushTick({
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      destination: "@me",
      digestEnabled: true,
      digestFlush,
      digestHourRaw: 18,
      digestQueueFile: join(f.dir, "digest.json"),
      digestSentFile: join(f.dir, "sent.json"),
      env: {},
      messagingRegistry: registry,
      now: () => new Date(2026, 6, 12, 18, 5, 0),
      provider: "log",
      quietHours: undefined,
      stdout: () => undefined
    });
    const claim = vi.fn(() => true);
    const tick = makeTick();
    await tick(claim);
    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: { discord: "B" }, version: 1 }));
    await tick(claim);
    expect(sent.map((message) => message.destination)).toEqual(["A", "B"]);

    const notDue = makeDigestFlushTick({
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      destination: "@me",
      digestEnabled: true,
      digestFlush,
      digestHourRaw: 17,
      digestQueueFile: join(f.dir, "digest.json"),
      digestSentFile: join(f.dir, "sent.json"),
      env: {},
      messagingRegistry: registry,
      now: () => new Date(2026, 6, 12, 18, 5, 0),
      provider: "log",
      quietHours: undefined,
      stdout: () => undefined
    });
    const claimBefore = claim.mock.calls.length;
    await notDue(claim);
    expect(digestFlush.mock.calls.length).toBe(2);
    expect(claim.mock.calls.length).toBe(claimBefore);

    writeFileSync(f.channelOwnersFile, JSON.stringify({ owners: { telegram: "A" }, version: 1 }));
    const invalidOutput: string[] = [];
    const invalid = makeDigestFlushTick({
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      destination: "@me",
      digestEnabled: true,
      digestFlush,
      digestHourRaw: 18,
      digestQueueFile: join(f.dir, "digest.json"),
      digestSentFile: join(f.dir, "sent.json"),
      env: { MUSE_LOCAL_ONLY: "true" },
      messagingRegistry: registry,
      now: () => new Date(2026, 6, 12, 18, 5, 0),
      provider: "log",
      quietHours: undefined,
      stdout: (message) => invalidOutput.push(message)
    });
    const callsBefore = digestFlush.mock.calls.length;
    await invalid(claim);
    expect(digestFlush.mock.calls.length).toBe(callsBefore);
    expect(claim.mock.calls.length).toBe(claimBefore);
    expect(sent).toHaveLength(2);
    expect(invalidOutput.join("")).not.toContain("private route details");

    const throwingDigestOutput: string[] = [];
    const throwingDigestClaim = vi.fn(() => true);
    const throwingDigest = makeDigestFlushTick({
      channelOwnersFile: f.channelOwnersFile,
      dayRhythmConfigFile: f.configFile,
      destination: "@me",
      digestEnabled: true,
      digestFlush,
      digestHourRaw: 18,
      digestQueueFile: join(f.dir, "throwing-digest.json"),
      digestSentFile: join(f.dir, "throwing-digest-sent.json"),
      env: {},
      messagingRegistry: { has: () => { throw new Error("private route details"); } } as unknown as MessagingProviderRegistry,
      now: () => new Date(2026, 6, 12, 18, 5, 0),
      provider: "log",
      quietHours: undefined,
      stdout: (message) => throwingDigestOutput.push(message)
    });
    await throwingDigest(throwingDigestClaim);
    expect(throwingDigestClaim).not.toHaveBeenCalled();
    expect(digestFlush.mock.calls.length).toBe(callsBefore);
    expect(throwingDigestOutput.join("")).not.toContain("private route details");
  });

  it("still resolves the route on disabled ticks before preserving the disabled outcome", async () => {
    const probes: string[] = [];
    const registry = { has: (providerId: string): boolean => { probes.push(providerId); throw new Error("private route details"); } } as unknown as MessagingProviderRegistry;
    const out: string[] = [];
    const tick = makeDigestFlushTick({
      channelOwnersFile: "/unused",
      dayRhythmConfigFile: "/unused",
      destination: "@me",
      digestEnabled: false,
      digestHourRaw: undefined,
      digestQueueFile: "/unused",
      digestSentFile: "/unused",
      env: {},
      messagingRegistry: registry,
      provider: "log",
      quietHours: undefined,
      stdout: (message) => out.push(message)
    });
    await expect(tick()).resolves.toEqual({ reason: "disabled", status: "not-ready" });
    expect(probes).toEqual(["log"]);
    expect(out).toEqual([]);
  });
});
