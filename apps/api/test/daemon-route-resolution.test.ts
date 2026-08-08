import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  digest: [] as Array<Record<string, unknown>>,
  proactive: [] as Array<Record<string, unknown>>
}));

vi.mock("../src/digest-tick.js", () => ({
  startDigestTick: (options: Record<string, unknown>) => {
    captured.digest.push(options);
    return { stop: vi.fn() };
  }
}));

vi.mock("../src/proactive-tick.js", () => ({
  createFileBackedActivityTracker: vi.fn(),
  createInMemoryActivityTracker: vi.fn(),
  startProactiveTick: (options: Record<string, unknown>) => {
    captured.proactive.push(options);
    return { stop: vi.fn() };
  }
}));

import { startDigestDaemonIfConfigured, startProactiveDaemonIfConfigured } from "../src/tick-daemons.js";

function provider(): MessagingProvider {
  return {
    describe: () => ({ description: "test", displayName: "Telegram", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      return { destination: message.destination, messageId: "test", providerId: "telegram" };
    }
  };
}

function fakeServer(): { readonly server: { readonly addHook: (name: string, hook: () => unknown) => void; readonly log: { readonly info: () => void; readonly warn: () => void } } } {
  return {
    server: {
      addHook: () => undefined,
      log: { info: () => undefined, warn: () => undefined }
    }
  };
}

describe("proactive and digest daemon starters", () => {
  beforeEach(() => {
    captured.digest.length = 0;
    captured.proactive.length = 0;
  });

  it("passes one paired Gateway route through both real starter paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-daemon-route-resolution-"));
    const ownersFile = join(root, "channel-owners.json");
    await writeFile(ownersFile, JSON.stringify({ owners: { telegram: "paired-555" }, version: 1 }));
    const registry = new MessagingProviderRegistry([provider()]);
    const options = {
      integrationEnv: { localOnly: false, messaging: { ownersFile } },
      messaging: registry,
      tasksFile: join(root, "tasks.json")
    } as unknown as Parameters<typeof startProactiveDaemonIfConfigured>[2];
    const phaseD = { phaseDProactiveOn: false, phaseDReminderOn: false };

    const proactiveServer = fakeServer();
    startProactiveDaemonIfConfigured({}, proactiveServer.server as never, options, phaseD);
    expect(captured.proactive).toHaveLength(1);
    expect(captured.proactive[0]).toMatchObject({
      destination: "paired-555",
      messagingRegistry: registry,
      providerId: "telegram"
    });

    const digestServer = fakeServer();
    startDigestDaemonIfConfigured({}, digestServer.server as never, options);
    expect(captured.digest).toHaveLength(1);
    expect(captured.digest[0]).toMatchObject({
      destination: "paired-555",
      providerId: "telegram",
      registry
    });

    const proactiveResolve = captured.proactive[0]!.resolveRoute as () => unknown;
    const digestResolve = captured.digest[0]!.resolveRoute as () => unknown;
    await writeFile(ownersFile, JSON.stringify({ owners: { telegram: "paired-666" }, version: 1 }));
    expect(proactiveResolve()).toEqual({
      destination: "paired-666",
      localOnly: false,
      providerId: "telegram",
      reason: null,
      source: "paired-owner",
      status: "resolved"
    });
    expect(digestResolve()).toEqual({
      destination: "paired-666",
      localOnly: false,
      providerId: "telegram",
      reason: null,
      source: "paired-owner",
      status: "resolved"
    });
    await writeFile(ownersFile, JSON.stringify({ owners: {}, version: 1 }));
    expect(proactiveResolve()).toEqual(expect.objectContaining({ status: "unconfigured", reason: "no-single-paired-route" }));
    expect(digestResolve()).toEqual(expect.objectContaining({ status: "unconfigured", reason: "no-single-paired-route" }));
  });

  it("starts paired auto-routing dormant and adopts a later owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-daemon-route-dormant-"));
    const ownersFile = join(root, "channel-owners.json");
    await writeFile(ownersFile, JSON.stringify({ owners: {}, version: 1 }));
    const registry = new MessagingProviderRegistry([provider()]);
    const options = {
      integrationEnv: { localOnly: false, messaging: { ownersFile } },
      messaging: registry,
      tasksFile: join(root, "tasks.json")
    } as unknown as Parameters<typeof startProactiveDaemonIfConfigured>[2];
    const phaseD = { phaseDProactiveOn: false, phaseDReminderOn: false };

    startProactiveDaemonIfConfigured({}, fakeServer().server as never, options, phaseD);
    startDigestDaemonIfConfigured({}, fakeServer().server as never, options);
    expect(captured.proactive).toHaveLength(1);
    expect(captured.digest).toHaveLength(1);
    const resolveProactive = captured.proactive[0]!.resolveRoute as () => unknown;
    const resolveDigest = captured.digest[0]!.resolveRoute as () => unknown;
    expect(resolveProactive()).toEqual(expect.objectContaining({ status: "unconfigured", reason: "no-single-paired-route" }));
    expect(resolveDigest()).toEqual(expect.objectContaining({ status: "unconfigured", reason: "no-single-paired-route" }));

    await writeFile(ownersFile, JSON.stringify({ owners: { telegram: "adopted-owner" }, version: 1 }));
    expect(resolveProactive()).toEqual(expect.objectContaining({ destination: "adopted-owner", providerId: "telegram", status: "resolved" }));
    expect(resolveDigest()).toEqual(expect.objectContaining({ destination: "adopted-owner", providerId: "telegram", status: "resolved" }));
  });

  it("does not let a partial explicit route fall through to the paired owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-daemon-route-partial-"));
    const ownersFile = join(root, "channel-owners.json");
    await writeFile(ownersFile, JSON.stringify({ owners: { telegram: "paired-555" }, version: 1 }));
    const options = {
      integrationEnv: { localOnly: false, messaging: { ownersFile } },
      messaging: new MessagingProviderRegistry([provider()]),
      tasksFile: join(root, "tasks.json")
    } as unknown as Parameters<typeof startProactiveDaemonIfConfigured>[2];

    startDigestDaemonIfConfigured(
      { MUSE_PROACTIVE_PROVIDER: "telegram", MUSE_CHANNEL_OWNERS_FILE: ownersFile },
      fakeServer().server as never,
      options
    );
    expect(captured.digest).toHaveLength(1);
    expect((captured.digest[0]!.resolveRoute as () => { readonly status: string })()).toEqual(expect.objectContaining({ status: "unconfigured" }));
  });

  it("does not replace an unavailable explicit provider with a paired owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-daemon-route-unavailable-"));
    const ownersFile = join(root, "channel-owners.json");
    await writeFile(ownersFile, JSON.stringify({ owners: { telegram: "paired-555" }, version: 1 }));
    const options = {
      integrationEnv: { localOnly: false, messaging: { ownersFile } },
      messaging: new MessagingProviderRegistry([provider()]),
      tasksFile: join(root, "tasks.json")
    } as unknown as Parameters<typeof startProactiveDaemonIfConfigured>[2];
    const env = {
      MUSE_PROACTIVE_DESTINATION: "explicit-destination",
      MUSE_PROACTIVE_PROVIDER: "unavailable-provider"
    } as NodeJS.ProcessEnv;

    startProactiveDaemonIfConfigured(env, fakeServer().server as never, options, { phaseDProactiveOn: false, phaseDReminderOn: false });
    startDigestDaemonIfConfigured(env, fakeServer().server as never, options);
    expect(captured.proactive).toHaveLength(1);
    expect(captured.digest).toHaveLength(1);
    expect((captured.proactive[0]!.resolveRoute as () => { readonly status: string })()).toEqual(expect.objectContaining({ status: "unconfigured" }));
    expect((captured.digest[0]!.resolveRoute as () => { readonly status: string })()).toEqual(expect.objectContaining({ status: "unconfigured" }));
  });
});
