import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { extractEmailAddress, unreadBriefingLine, type EmailProvider, type EmailSummary } from "../src/index.js";
import { writeObjectives } from "@muse/stores";
import { runDueSituationalBriefing } from "../src/situational-briefing-loop.js";

describe("extractEmailAddress", () => {
  it("pulls the address from a display-name header and lowercases it", () => {
    expect(extractEmailAddress("Alice <Alice@X.com>")).toBe("alice@x.com");
    expect(extractEmailAddress("bob@y.com")).toBe("bob@y.com");
  });
  it("returns undefined when there is no address", () => {
    expect(extractEmailAddress("(unknown)")).toBeUndefined();
  });
});

const UNREAD: EmailSummary[] = [
  { from: "Daily News <news@news.com>", id: "1", snippet: "", subject: "Today's headlines", unread: true },
  { from: "Bob Acme <bob@acme.com>", id: "2", snippet: "", subject: "Re: the contract", unread: true },
  { from: "promos@shop.com", id: "3", snippet: "", subject: "50% off", unread: true }
];

describe("unreadBriefingLine — people-first triage", () => {
  it("surfaces a known contact's unread FIRST and flags it ★", () => {
    const line = unreadBriefingLine(UNREAD, { isKnownSender: (from) => extractEmailAddress(from) === "bob@acme.com" });
    expect(line).toContain("3 unread");
    // Bob is named first, starred; he was second in feed order.
    expect(line!.indexOf("★ “Re: the contract” (Bob Acme)")).toBe(line!.indexOf("— ") + 2);
  });

  it("without the predicate, keeps feed order and adds no ★", () => {
    const line = unreadBriefingLine(UNREAD);
    expect(line).not.toContain("★");
    expect(line).toContain("“Today's headlines”");
  });
});

function capturingProvider(sent: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
    }
  };
}

const emailProvider: EmailProvider = { listRecent: async () => UNREAD };

describe("runDueSituationalBriefing — the inbox line flags a known sender end-to-end", () => {
  it("a brief's Inbox line surfaces the known contact first with ★", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-known-sender-"));
    await writeObjectives(join(dir, "objectives.json"), []);
    const now = new Date();
    const sent: OutboundMessage[] = [];
    const summary = await runDueSituationalBriefing({
      destination: "555",
      emailProvider,
      imminent: [{ startsAt: new Date(now.getTime() + 1_800_000), title: "Standup" }],
      inboxKnownSender: (from) => extractEmailAddress(from) === "bob@acme.com",
      messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
      now: () => now,
      objectivesFile: join(dir, "objectives.json"),
      providerId: "telegram",
      sidecarFile: join(dir, "sidecar.json")
    });
    expect(summary.delivered).toBe(1);
    expect(sent[0]!.text).toContain("Inbox: 3 unread");
    expect(sent[0]!.text).toContain("★ “Re: the contract” (Bob Acme)");
  });
});
