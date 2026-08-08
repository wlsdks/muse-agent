import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProactiveMessagingRoute } from "@muse/autoconfigure";
import type { MessagingRouteResolution } from "@muse/autoconfigure";
import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  runDue: vi.fn(async (_options: { readonly providerId: string; readonly destination: string }): Promise<{ readonly delivered: 1 }> => ({ delivered: 1 }))
}));

vi.mock("@muse/domain-tools", () => ({ runDueSituationalBriefing: hoisted.runDue }));

import { startSituationalBriefingTick } from "../src/situational-briefing-tick.js";

function routeProvider(
  id: string,
  sent: Array<{ readonly destination: string; readonly providerId: string }>
): MessagingProvider {
  return {
    describe: () => ({ description: "briefing-route-test", displayName: id, id }),
    id,
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push({ destination: message.destination, providerId: id });
      return { destination: message.destination, messageId: `${id}-message`, providerId: id };
    }
  };
}

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), "muse-brief-route-gate-"));
  return {
    objectivesFile: join(dir, "objectives.json"),
    ownersFile: join(dir, "channel-owners.json"),
    sidecarFile: join(dir, "briefing-fired.json")
  };
}

function startWithRoute(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly ownersFile?: string;
    readonly registry: MessagingProviderRegistry;
  }
) {
  const { objectivesFile, sidecarFile } = fixtures();
  const resolveRoute = (): MessagingRouteResolution => resolveProactiveMessagingRoute(env, {
    allowBriefingFallback: true,
    ...(options.ownersFile ? { ownersFile: options.ownersFile } : {}),
    registry: options.registry
  });
  return startSituationalBriefingTick({
    objectivesFile,
    registry: options.registry,
    resolveRoute,
    sidecarFile,
    windowMs: 0
  });
}

afterEach(() => {
  hoisted.runDue.mockClear();
});

describe("startSituationalBriefingTick — Gateway route gate", () => {
  it.each([
    ["no paired route", { owners: {} }],
    ["multiple paired routes", { owners: { discord: "owner-b", telegram: "owner-a" } }],
    ["malformed owner data", "not-json"]
  ])("does not invoke the briefing core for %s", async (_label, owners) => {
    const { ownersFile } = fixtures();
    await writeFile(ownersFile, typeof owners === "string" ? owners : JSON.stringify(owners));
    const sent: Array<{ readonly destination: string; readonly providerId: string }> = [];
    const registry = new MessagingProviderRegistry([
      routeProvider("telegram", sent),
      routeProvider("discord", sent)
    ]);
    const handle = startWithRoute({}, { ownersFile, registry });
    try {
      await handle.tickOnce();
      expect(hoisted.runDue).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    } finally {
      handle.stop();
    }
  });

  it.each([
    ["unregistered explicit provider", { MUSE_PROACTIVE_DESTINATION: "owner-a", MUSE_PROACTIVE_PROVIDER: "not-registered" }],
    ["incomplete explicit route", { MUSE_PROACTIVE_PROVIDER: "telegram" }],
    ["remote route under local-only", {
      MUSE_LOCAL_ONLY: "true",
      MUSE_PROACTIVE_DESTINATION: "owner-a",
      MUSE_PROACTIVE_PROVIDER: "telegram"
    }]
  ])("does not invoke the briefing core for %s", async (_label, env) => {
    const sent: Array<{ readonly destination: string; readonly providerId: string }> = [];
    const registry = new MessagingProviderRegistry([routeProvider("telegram", sent)]);
    const handle = startWithRoute(env, { registry });
    try {
      await handle.tickOnce();
      expect(hoisted.runDue).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    } finally {
      handle.stop();
    }
  });

  it("sanitizes a resolver throw and keeps the raw error out of logs and delivery", async () => {
    const sent: Array<{ readonly destination: string; readonly providerId: string }> = [];
    const errors: string[] = [];
    const registry = new MessagingProviderRegistry([routeProvider("telegram", sent)]);
    const { objectivesFile, sidecarFile } = fixtures();
    const handle = startSituationalBriefingTick({
      errorLogger: (message) => errors.push(message),
      objectivesFile,
      registry,
      resolveRoute: () => {
        throw new Error("owner-secret-must-not-leak");
      },
      sidecarFile
    });
    try {
      await handle.tickOnce();
      expect(hoisted.runDue).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(errors).toEqual(["situational-briefing-tick: route-unavailable"]);
      expect(errors.join(" ")).not.toContain("owner-secret-must-not-leak");
    } finally {
      handle.stop();
    }
  });
});
