import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProactiveMessagingRoute } from "@muse/autoconfigure";
import { MessagingProviderRegistry, type MessagingProvider, type MessagingProviderId, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { appendDigestItem, readDigestQueue } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { startDigestTick } from "../src/digest-tick.js";
import { createDigestRuntimeStatusStore } from "../src/digest-runtime-status.js";
import { startDigestDaemonIfConfigured } from "../src/tick-daemons.js";

interface MessageSent { readonly providerId: string; readonly destination: string; readonly text: string }

function resolvedRoute(providerId: string, destination: string) {
  return {
    destination,
    localOnly: false,
    providerId,
    reason: null,
    source: "explicit-config" as const,
    status: "resolved" as const
  };
}

function fakeRegistry(sent: MessageSent[]): MessagingProviderRegistry {
  return {
    send: async (providerId: string, message: { destination: string; text: string }) => {
      sent.push({ destination: message.destination, providerId, text: message.text });
      return { destination: message.destination, messageId: "stub", providerId };
    }
  } as unknown as MessagingProviderRegistry;
}

describe("startDigestTick", () => {
  it("fires the compiled digest at the digest hour and drains the queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-digest-tick-"));
    const digestFile = join(root, "digest-queue.json");
    await appendDigestItem(digestFile, { at: new Date(2026, 4, 12, 9, 0, 0), source: "pattern-firing", text: "notice one" });
    const sent: MessageSent[] = [];
    const decisions: string[] = [];
    let resolveCalls = 0;
    const handle = startDigestTick({
      digestFile,
      localOnly: false,
      now: () => new Date(2026, 4, 12, 18, 0, 0),
      resolveRoute: () => {
        resolveCalls += 1;
        return resolvedRoute("telegram", "@me");
      },
      registry: fakeRegistry(sent),
      runtimeStatus: {
        get: () => null,
        record: (update) => decisions.push(update.decision)
      },
      sentFile: join(root, "digest-sent.json")
    });
    try {
      await handle.tickOnce();
      expect(resolveCalls).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain("notice one");
      expect(decisions).not.toContain("route-unavailable");
      expect(await readDigestQueue(digestFile)).toHaveLength(0);
    } finally {
      handle.stop();
    }
  });

  it("skips firing during the quiet-hour window (queue preserved)", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-digest-tick-quiet-"));
    const digestFile = join(root, "digest-queue.json");
    await appendDigestItem(digestFile, { at: new Date(2026, 4, 12, 9, 0, 0), source: "pattern-firing", text: "notice one" });
    const sent: MessageSent[] = [];
    const runtimeStatus = createDigestRuntimeStatusStore();
    let resolveCalls = 0;
    const handle = startDigestTick({
      digestFile,
      localOnly: false,
      // 18:00 is the digest hour but also inside a 17-23 quiet window here.
      now: () => new Date(2026, 4, 12, 18, 0, 0),
      quietHours: { endHour: 23, startHour: 17 },
      resolveRoute: () => {
        resolveCalls += 1;
        return resolvedRoute("telegram", "@me");
      },
      runtimeStatus,
      registry: fakeRegistry(sent),
      sentFile: join(root, "digest-sent.json")
    });
    try {
      await handle.tickOnce();
      expect(resolveCalls).toBe(0);
      expect(sent).toEqual([]);
      expect(await readDigestQueue(digestFile)).toHaveLength(1);
      expect(runtimeStatus.get()).toMatchObject({
        availability: "observed",
        lastDecision: "quiet-hours",
        lastErrorCount: 0,
        lastItemCount: 0,
        phase: "tick"
      });
    } finally {
      handle.stop();
    }
  });

  it("logger surfaces the outcome on a successful send", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-digest-tick-log-"));
    const digestFile = join(root, "digest-queue.json");
    await appendDigestItem(digestFile, { at: new Date(2026, 4, 12, 9, 0, 0), source: "pattern-firing", text: "notice one" });
    const lines: string[] = [];
    const handle = startDigestTick({
      digestFile,
      logger: (m) => lines.push(m),
      localOnly: false,
      now: () => new Date(2026, 4, 12, 18, 0, 0),
      resolveRoute: () => resolvedRoute("telegram", "@me"),
      registry: fakeRegistry([]),
      sentFile: join(root, "digest-sent.json")
    });
    try {
      await handle.tickOnce();
      expect(lines.some((l) => l.includes("digest-tick: sent (1 item(s))"))).toBe(true);
    } finally {
      handle.stop();
    }
  });

  it("a second tickOnce the same day does not re-send (already-sent-today)", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-digest-tick-dedupe-"));
    const digestFile = join(root, "digest-queue.json");
    await appendDigestItem(digestFile, { at: new Date(2026, 4, 12, 9, 0, 0), source: "pattern-firing", text: "notice one" });
    const sent: MessageSent[] = [];
    const handle = startDigestTick({
      digestFile,
      localOnly: false,
      now: () => new Date(2026, 4, 12, 18, 0, 0),
      resolveRoute: () => resolvedRoute("telegram", "@me"),
      registry: fakeRegistry(sent),
      sentFile: join(root, "digest-sent.json")
    });
    try {
      await handle.tickOnce();
      expect(sent).toHaveLength(1);
      await appendDigestItem(digestFile, { at: new Date(2026, 4, 12, 19, 0, 0), source: "ambient-notice", text: "notice two" });
      await handle.tickOnce();
      expect(sent).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it("re-resolves the paired owner before each delivery and no-ops when pairing is invalid", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-digest-tick-route-refresh-"));
    const ownersFile = join(root, "channel-owners.json");
    const digestFile = join(root, "digest-queue.json");
    const sentFile = join(root, "digest-sent.json");
    await writeFile(ownersFile, JSON.stringify({ owners: { telegram: "owner-a" }, version: 1 }));
    await appendDigestItem(digestFile, { at: new Date("2026-05-12T09:00:00.000Z"), source: "pattern-firing", text: "notice one" });
    const sent: MessageSent[] = [];
    const runtimeStatus = createDigestRuntimeStatusStore();
    const registry = new MessagingProviderRegistry([
      capturingProvider(sent, "telegram"),
      capturingProvider(sent, "discord")
    ]);
    let now = new Date(2026, 4, 12, 18, 0, 0);
    const resolveRoute = () => {
      const resolution = resolveProactiveMessagingRoute({}, { ownersFile, registry });
      return resolution;
    };
    const handle = startDigestTick({
      digestFile,
      localOnly: false,
      now: () => now,
      registry,
      runtimeStatus,
      resolveRoute,
      sentFile
    });
    try {
      await handle.tickOnce();
      expect(runtimeStatus.get()?.lastRoute).toEqual({
        destination: "owner-a",
        localOnly: false,
        providerId: "telegram",
        reason: null,
        source: "paired-owner",
        status: "resolved"
      });
      await writeFile(ownersFile, JSON.stringify({ owners: { discord: "owner-b" }, version: 1 }));
      await appendDigestItem(digestFile, { at: new Date("2026-05-13T09:00:00.000Z"), source: "pattern-firing", text: "notice two" });
      now = new Date(2026, 4, 13, 18, 0, 0);
      await handle.tickOnce();
      expect(runtimeStatus.get()?.lastRoute).toEqual({
        destination: "owner-b",
        localOnly: false,
        providerId: "discord",
        reason: null,
        source: "paired-owner",
        status: "resolved"
      });

      expect(sent.map((message) => ({ destination: message.destination, providerId: message.providerId }))).toEqual([
        { destination: "owner-a", providerId: "telegram" },
        { destination: "owner-b", providerId: "discord" }
      ]);

      await writeFile(ownersFile, JSON.stringify({ owners: { discord: "owner-b", telegram: "owner-a" }, version: 1 }));
      await appendDigestItem(digestFile, { at: new Date("2026-05-14T09:00:00.000Z"), source: "pattern-firing", text: "notice three" });
      now = new Date(2026, 4, 14, 18, 0, 0);
      await handle.tickOnce();
      expect(sent).toHaveLength(2);
      expect(runtimeStatus.get()?.lastRoute).toEqual({
        destination: null,
        localOnly: false,
        providerId: null,
        reason: "multiple-paired-routes",
        source: null,
        status: "ambiguous"
      });
      expect(await readDigestQueue(digestFile)).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it("starts empty and records a fail-closed unavailable-route decision", async () => {
    const runtimeStatus = createDigestRuntimeStatusStore();
    const observedAt = new Date("2026-05-12T09:00:00.000Z");
    expect(runtimeStatus.get()).toBeNull();
    const handle = startDigestTick({
      digestFile: join(tmpdir(), "muse-digest-route-unavailable.json"),
      localOnly: false,
      now: () => observedAt,
      registry: fakeRegistry([]),
      resolveRoute: () => undefined,
      runtimeStatus,
      sentFile: join(tmpdir(), "muse-digest-route-unavailable-sent.json")
    });
    try {
      await handle.tickOnce();
      expect(runtimeStatus.get()).toMatchObject({
        availability: "observed",
        lastDecision: "route-unavailable",
        lastErrorCount: 0,
        lastItemCount: 0,
        lastObservedAtIso: observedAt.toISOString(),
        phase: "tick"
      });
    } finally {
      handle.stop();
    }
  });

  it("turns a resolver throw into a bounded receipt without calling or logging the raw failure", async () => {
    const sent: MessageSent[] = [];
    const errors: string[] = [];
    const runtimeStatus = createDigestRuntimeStatusStore();
    const handle = startDigestTick({
      digestFile: join(tmpdir(), "muse-digest-route-throw.json"),
      errorLogger: (message) => errors.push(message),
      localOnly: false,
      now: () => new Date(2026, 4, 12, 18, 0, 0),
      registry: fakeRegistry(sent),
      resolveRoute: () => { throw new Error("secret route detail"); },
      runtimeStatus,
      sentFile: join(tmpdir(), "muse-digest-route-throw-sent.json")
    });
    try {
      await handle.tickOnce();
      expect(sent).toEqual([]);
      expect(errors).toEqual([]);
      expect(runtimeStatus.get()?.lastDecision).toBe("route-unavailable");
      expect(runtimeStatus.get()?.lastRoute).toEqual({
        destination: null,
        localOnly: false,
        providerId: null,
        reason: "paired-route-inspection-unavailable",
        source: null,
        status: "unconfigured"
      });
      expect(JSON.stringify(runtimeStatus.get())).not.toContain("secret route detail");
    } finally {
      handle.stop();
    }
  });

  it("records a local-only block and never calls the provider", async () => {
    const sent: MessageSent[] = [];
    const runtimeStatus = createDigestRuntimeStatusStore();
    const handle = startDigestTick({
      digestFile: join(tmpdir(), "muse-digest-route-local-only.json"),
      localOnly: true,
      now: () => new Date(2026, 4, 12, 18, 0, 0),
      registry: fakeRegistry(sent),
      resolveRoute: () => ({
        destination: "owner",
        localOnly: true,
        providerId: "telegram",
        reason: "remote-route-blocked-by-local-only",
        source: "explicit-config",
        status: "blocked-local-only"
      }),
      runtimeStatus,
      sentFile: join(tmpdir(), "muse-digest-route-local-only-sent.json")
    });
    try {
      await handle.tickOnce();
      expect(sent).toEqual([]);
      expect(runtimeStatus.get()?.lastRoute).toEqual({
        destination: "owner",
        localOnly: true,
        providerId: "telegram",
        reason: "remote-route-blocked-by-local-only",
        source: "explicit-config",
        status: "blocked-local-only"
      });
    } finally {
      handle.stop();
    }
  });

  it("does not let a runtime receipt failure alter digest delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-digest-runtime-store-throw-"));
    const digestFile = join(root, "digest-queue.json");
    await appendDigestItem(digestFile, { at: new Date("2026-05-12T09:00:00.000Z"), source: "pattern-firing", text: "notice one" });
    const sent: MessageSent[] = [];
    const handle = startDigestTick({
      digestFile,
      localOnly: false,
      now: () => new Date(2026, 4, 12, 18, 0, 0),
      registry: fakeRegistry(sent),
      resolveRoute: () => resolvedRoute("telegram", "owner"),
      runtimeStatus: { get: () => null, record: () => { throw new Error("status store failure"); } },
      sentFile: join(root, "digest-sent.json")
    });
    try {
      await expect(handle.tickOnce()).resolves.toBeUndefined();
      expect(sent).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });
});

function capturingProvider(sent: MessageSent[], id: MessagingProviderId = "telegram"): MessagingProvider {
  return {
    describe: () => ({ description: "test", displayName: "Test", id }),
    id,
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push({ destination: message.destination, providerId: id, text: message.text });
      return { destination: message.destination, messageId: "m1", providerId: id };
    }
  };
}

function fakeServer() {
  const hooks: { name: string; fn: () => unknown }[] = [];
  return {
    hooks,
    server: { addHook: (name: string, fn: () => unknown) => hooks.push({ fn, name }), log: { info: () => undefined, warn: () => undefined } }
  };
}

describe("startDigestDaemonIfConfigured — env-gated registration", () => {
  const options = { messaging: new MessagingProviderRegistry([capturingProvider([])]) } as unknown as Parameters<typeof startDigestDaemonIfConfigured>[2];
  const env = {
    MUSE_PROACTIVE_DESTINATION: "555",
    MUSE_PROACTIVE_PROVIDER: "telegram"
  } as unknown as NodeJS.ProcessEnv;

  it("registers an onClose stop hook when MUSE_DIGEST_ENABLED defaults to true and the proactive channel is configured", () => {
    const { hooks, server } = fakeServer();
    const runtimeStatus = createDigestRuntimeStatusStore();
    startDigestDaemonIfConfigured(env, server as never, options, runtimeStatus);
    expect(hooks.filter((h) => h.name === "onClose")).toHaveLength(1);
    expect(runtimeStatus.get()).toMatchObject({
      availability: "dormant",
      lastDecision: "startup",
      lastRoute: {
        destination: "555",
        localOnly: false,
        providerId: "telegram",
        reason: null,
        source: "explicit-config",
        status: "resolved"
      },
      phase: "startup"
    });
  });

  it("MUSE_DIGEST_ENABLED=false ⇒ NOT started", () => {
    const { hooks, server } = fakeServer();
    const runtimeStatus = createDigestRuntimeStatusStore();
    startDigestDaemonIfConfigured({ ...env, MUSE_DIGEST_ENABLED: "false" } as NodeJS.ProcessEnv, server as never, options, runtimeStatus);
    expect(hooks).toHaveLength(0);
    expect(runtimeStatus.get()).toMatchObject({ availability: "disabled", lastDecision: "startup", phase: "startup" });
  });

  it("delivery brake records blocked startup without creating a timer or close hook", () => {
    const { hooks, server } = fakeServer();
    const runtimeStatus = createDigestRuntimeStatusStore();
    startDigestDaemonIfConfigured(env, server as never, options, runtimeStatus, true);
    expect(hooks).toHaveLength(0);
    expect(runtimeStatus.get()).toMatchObject({ availability: "blocked", lastDecision: "startup", phase: "startup" });
  });

  it("no explicit route starts a paired daemon dormant until an owner exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-digest-daemon-dormant-"));
    const ownersFile = join(root, "channel-owners.json");
    await writeFile(ownersFile, JSON.stringify({ owners: {}, version: 1 }));
    const { hooks, server } = fakeServer();
    const dormantOptions = {
      ...options,
      integrationEnv: { localOnly: false, messaging: { ownersFile } }
    } as unknown as Parameters<typeof startDigestDaemonIfConfigured>[2];
    startDigestDaemonIfConfigured({} as NodeJS.ProcessEnv, server as never, dormantOptions);
    expect(hooks.filter((h) => h.name === "onClose")).toHaveLength(1);
  });

  it("keeps an invalid explicit route alive so the tick can record a fail-closed receipt", () => {
    const { hooks, server } = fakeServer();
    const noProviderOptions = { messaging: new MessagingProviderRegistry([]) } as unknown as Parameters<typeof startDigestDaemonIfConfigured>[2];
    startDigestDaemonIfConfigured(env, server as never, noProviderOptions);
    expect(hooks.filter((h) => h.name === "onClose")).toHaveLength(1);
  });
});
