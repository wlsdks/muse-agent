import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileAmbientSignalSource, parseAmbientNoticeRules } from "@muse/proactivity";
import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startAmbientTick } from "../src/ambient-tick.js";
import { startAmbientDaemonIfConfigured } from "../src/tick-daemons.js";

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

const RULES = parseAmbientNoticeRules(JSON.stringify([
  { id: "standup", match: { window: "standup" }, message: "Standup at 14:00 — open your notes.", title: "Standup" }
]));

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-ambient-tick-"));
  file = join(dir, "ambient.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("startAmbientTick — delivers a matched ambient notice through the messaging registry", () => {
  it("tickOnce sends the notice to the configured provider/destination", async () => {
    await writeFile(file, JSON.stringify({ app: "Calendar", window: "Team Standup — 14:00" }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    const handle = startAmbientTick({
      destination: "555",
      providerId: "telegram",
      registry,
      rules: RULES,
      source: new FileAmbientSignalSource(file)
    });
    try {
      await handle.tickOnce();
      await handle.tickOnce(); // edge-triggered: same signal → no second send
    } finally {
      handle.stop();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.destination).toBe("555");
    expect(sent[0]!.text).toContain("Standup at 14:00");
  });

  it("no matching rule → nothing sent", async () => {
    await writeFile(file, JSON.stringify({ window: "Spotify" }), "utf8");
    const sent: OutboundMessage[] = [];
    const handle = startAmbientTick({
      destination: "555",
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      rules: RULES,
      source: new FileAmbientSignalSource(file)
    });
    try {
      await handle.tickOnce();
    } finally {
      handle.stop();
    }
    expect(sent).toHaveLength(0);
  });
});

describe("startAmbientTick — SB-3 knowledge trigger fires over the channel with NO rules", () => {
  it("the active window title connecting to the corpus edge-fires a recall notice", async () => {
    await writeFile(file, JSON.stringify({ app: "Notion", window: "Q3 budget — Notion" }), "utf8");
    const sent: OutboundMessage[] = [];
    const handle = startAmbientTick({
      destination: "555",
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      rules: [],
      source: new FileAmbientSignalSource(file),
      knowledgeTrigger: {
        enrich: (query) => query.toLowerCase().includes("q3 budget")
          ? "[notes/finance.md] Q3 ad spend capped at 12k"
          : undefined
      }
    });
    try {
      await handle.tickOnce();
      await handle.tickOnce(); // same window → edge-deduped, no second send
    } finally {
      handle.stop();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.destination).toBe("555");
    expect(sent[0]!.text).toContain("Q3 ad spend capped at 12k");
    expect(sent[0]!.text).toContain("second brain");
  });

  it("a window title that connects to nothing stays silent", async () => {
    await writeFile(file, JSON.stringify({ window: "Spotify" }), "utf8");
    const sent: OutboundMessage[] = [];
    const handle = startAmbientTick({
      destination: "555",
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      rules: [],
      source: new FileAmbientSignalSource(file),
      knowledgeTrigger: { enrich: () => undefined }
    });
    try {
      await handle.tickOnce();
    } finally {
      handle.stop();
    }
    expect(sent).toHaveLength(0);
  });
});

function fakeServer() {
  const hooks: { name: string; fn: () => unknown }[] = [];
  return {
    hooks,
    server: { addHook: (name: string, fn: () => unknown) => hooks.push({ fn, name }), log: { info: () => undefined, warn: () => undefined } }
  };
}

describe("startAmbientDaemonIfConfigured — env-gated registration", () => {
  const options = { messaging: new MessagingProviderRegistry([capturingProvider([])]) } as unknown as Parameters<typeof startAmbientDaemonIfConfigured>[2];
  const env = {
    MUSE_AMBIENT_DESTINATION: "555",
    MUSE_AMBIENT_ENABLED: "true",
    MUSE_AMBIENT_PROVIDER: "telegram",
    MUSE_AMBIENT_RULES: JSON.stringify([{ id: "s", match: { window: "standup" }, message: "m", title: "t" }])
  } as unknown as NodeJS.ProcessEnv;

  it("registers an onClose stop hook when fully configured", () => {
    const { hooks, server } = fakeServer();
    startAmbientDaemonIfConfigured(env, server as never, options);
    expect(hooks.filter((h) => h.name === "onClose")).toHaveLength(1);
  });

  it("absent env / no rules ⇒ NOT started", () => {
    const { hooks, server } = fakeServer();
    startAmbientDaemonIfConfigured({} as NodeJS.ProcessEnv, server as never, options);
    startAmbientDaemonIfConfigured({ ...env, MUSE_AMBIENT_RULES: "[]" } as NodeJS.ProcessEnv, server as never, options);
    expect(hooks).toHaveLength(0);
  });

  it("no rules but knowledge trigger enabled ⇒ started (SB-3); the flag alone without the enricher ⇒ NOT started", () => {
    const triggerEnv = {
      ...env,
      MUSE_AMBIENT_RULES: "[]",
      MUSE_AMBIENT_KNOWLEDGE_TRIGGER: "true"
    } as unknown as NodeJS.ProcessEnv;

    const flagOnly = fakeServer();
    startAmbientDaemonIfConfigured(triggerEnv, flagOnly.server as never, options);
    expect(flagOnly.hooks).toHaveLength(0); // MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED off ⇒ no enricher ⇒ no trigger

    const withEnricher = fakeServer();
    startAmbientDaemonIfConfigured(
      { ...triggerEnv, MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED: "true" } as NodeJS.ProcessEnv,
      withEnricher.server as never,
      options
    );
    expect(withEnricher.hooks.filter((h) => h.name === "onClose")).toHaveLength(1);
  });
});
