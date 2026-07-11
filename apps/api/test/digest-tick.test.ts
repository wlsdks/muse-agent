import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { appendDigestItem, readDigestQueue } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { startDigestTick } from "../src/digest-tick.js";
import { startDigestDaemonIfConfigured } from "../src/tick-daemons.js";

interface MessageSent { readonly providerId: string; readonly destination: string; readonly text: string }

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
    const handle = startDigestTick({
      destination: "@me",
      digestFile,
      now: () => new Date(2026, 4, 12, 18, 0, 0),
      providerId: "telegram",
      registry: fakeRegistry(sent),
      sentFile: join(root, "digest-sent.json")
    });
    try {
      await handle.tickOnce();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain("notice one");
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
    const handle = startDigestTick({
      destination: "@me",
      digestFile,
      // 18:00 is the digest hour but also inside a 17-23 quiet window here.
      now: () => new Date(2026, 4, 12, 18, 0, 0),
      providerId: "telegram",
      quietHours: { endHour: 23, startHour: 17 },
      registry: fakeRegistry(sent),
      sentFile: join(root, "digest-sent.json")
    });
    try {
      await handle.tickOnce();
      expect(sent).toEqual([]);
      expect(await readDigestQueue(digestFile)).toHaveLength(1);
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
      destination: "@me",
      digestFile,
      logger: (m) => lines.push(m),
      now: () => new Date(2026, 4, 12, 18, 0, 0),
      providerId: "telegram",
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
      destination: "@me",
      digestFile,
      now: () => new Date(2026, 4, 12, 18, 0, 0),
      providerId: "telegram",
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
});

function capturingProvider(sent: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
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
    startDigestDaemonIfConfigured(env, server as never, options);
    expect(hooks.filter((h) => h.name === "onClose")).toHaveLength(1);
  });

  it("MUSE_DIGEST_ENABLED=false ⇒ NOT started", () => {
    const { hooks, server } = fakeServer();
    startDigestDaemonIfConfigured({ ...env, MUSE_DIGEST_ENABLED: "false" } as NodeJS.ProcessEnv, server as never, options);
    expect(hooks).toHaveLength(0);
  });

  it("no proactive provider/destination configured ⇒ NOT started", () => {
    const { hooks, server } = fakeServer();
    startDigestDaemonIfConfigured({} as NodeJS.ProcessEnv, server as never, options);
    expect(hooks).toHaveLength(0);
  });

  it("messaging registry missing the named provider ⇒ NOT started", () => {
    const { hooks, server } = fakeServer();
    const noProviderOptions = { messaging: new MessagingProviderRegistry([]) } as unknown as Parameters<typeof startDigestDaemonIfConfigured>[2];
    startDigestDaemonIfConfigured(env, server as never, noProviderOptions);
    expect(hooks).toHaveLength(0);
  });
});
