import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startSituationalBriefingTick } from "../src/situational-briefing-tick.js";

function capturing(sent: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m", providerId: "telegram" };
    }
  };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-brief-tick-rel-")); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

describe("startSituationalBriefingTick — forwards relatedKnowledge to the brief", () => {
  it("a non-empty brief gains the related-note line from the enricher", async () => {
    const sent: OutboundMessage[] = [];
    const handle = startSituationalBriefingTick({
      imminent: [{ kind: "event", startsAt: new Date(Date.now() + 30 * 60_000), title: "Acme strategy meeting" }],
      localOnly: false,
      objectivesFile: join(dir, "obj.json"),
      registry: new MessagingProviderRegistry([capturing(sent)]),
      relatedKnowledge: (query) => (query.includes("Acme") ? "[notes/acme.md] prep: bring the Q3 deck" : undefined),
      resolveRoute: () => ({
        destination: "555",
        localOnly: false,
        providerId: "telegram",
        reason: null,
        source: "explicit-config" as const,
        status: "resolved" as const
      }),
      sidecarFile: join(dir, "sidecar.json")
    });
    try {
      await handle.tickOnce();
    } finally {
      handle.stop();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Related: [notes/acme.md] prep: bring the Q3 deck");
  });
});
