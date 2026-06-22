import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileAmbientSignalSource, parseAmbientNoticeRules } from "@muse/proactivity";
import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startAmbientTick } from "../src/ambient-tick.js";

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
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-ambient-enrich-")); file = join(dir, "ambient.json"); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

describe("startAmbientTick — forwards the knowledge enricher", () => {
  it("a firing ambient notice gains a Related line from the enricher", async () => {
    await writeFile(file, JSON.stringify({ app: "Chrome", window: "Acme — Q3 Strategy" }), "utf8");
    const rules = parseAmbientNoticeRules(JSON.stringify([
      { id: "acme", match: { window: "acme" }, message: "On the Acme doc.", title: "Acme" }
    ]));
    const sent: OutboundMessage[] = [];
    const handle = startAmbientTick({
      destination: "555",
      enrich: (query) => (query.includes("Acme") ? "[notes/acme.md] bring the Q3 deck" : undefined),
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturing(sent)]),
      rules,
      source: new FileAmbientSignalSource(file)
    });
    try {
      await handle.tickOnce();
    } finally {
      handle.stop();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("On the Acme doc.");
    expect(sent[0]!.text).toContain("Related: [notes/acme.md] bring the Q3 deck");
  });
});
