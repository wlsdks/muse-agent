import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDueSituationalBriefing } from "../src/index.js";
import { composeSituationalBriefing, type BriefingImminent } from "@muse/mcp";

const RELATED = "[notes/acme.md] prep: bring the Q3 deck";
const imminentItem: BriefingImminent = { kind: "event", startsAt: new Date(Date.now() + 30 * 60_000), title: "Acme strategy meeting" };

describe("composeSituationalBriefing — Related line", () => {
  it("includes a Related: line when `related` is set", () => {
    const text = composeSituationalBriefing({ imminent: [imminentItem], now: new Date(), objectives: [], related: RELATED });
    expect(text).toContain("Upcoming:");
    expect(text).toContain(`Related: ${RELATED}`);
  });

  it("omits Related when unset", () => {
    const text = composeSituationalBriefing({ imminent: [imminentItem], now: new Date(), objectives: [] });
    expect(text).not.toContain("Related:");
  });
});

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
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-brief-rel-")); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

function baseOptions(sent: OutboundMessage[], relatedKnowledge: RunArg) {
  return {
    destination: "555",
    imminent: [imminentItem],
    messagingRegistry: new MessagingProviderRegistry([capturing(sent)]),
    objectivesFile: join(dir, "obj.json"),
    providerId: "telegram",
    relatedKnowledge,
    sidecarFile: join(dir, "sidecar.json")
  };
}
type RunArg = (query: string) => Promise<string | undefined> | string | undefined;

describe("runDueSituationalBriefing — proactive related-knowledge surfacing", () => {
  it("calls the enricher with the top imminent item's title and adds its line", async () => {
    const sent: OutboundMessage[] = [];
    let askedFor: string | undefined;
    const summary = await runDueSituationalBriefing(baseOptions(sent, (q) => { askedFor = q; return RELATED; }));
    expect(summary.delivered).toBe(1);
    expect(askedFor).toBe("Acme strategy meeting");
    expect(sent[0]!.text).toContain(`Related: ${RELATED}`);
  });

  it("fail-soft: a throwing enricher still delivers the brief, without a Related line", async () => {
    const sent: OutboundMessage[] = [];
    const summary = await runDueSituationalBriefing(baseOptions(sent, () => { throw new Error("corpus down"); }));
    expect(summary.delivered).toBe(1);
    expect(sent[0]!.text).not.toContain("Related:");
  });
});
