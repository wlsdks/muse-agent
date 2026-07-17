import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listPendingApprovals, recordPendingApproval, type PendingApproval } from "@muse/messaging";
import { describe, expect, it, vi } from "vitest";

import { handleInboundApprovalReply } from "../src/inbound-approval-handler.js";

function pendingFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-inbound-appr-")), "pending-approvals.json");
}

function entry(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    arguments: { summary: "Book a table", url: "http://x.test/book" },
    createdAt: new Date().toISOString(),
    draft: "POST http://x.test/book",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    id: "p1",
    providerId: "telegram",
    risk: "execute",
    source: "42",
    tool: "web_action",
    ...overrides
  };
}

describe("handleInboundApprovalReply", () => {
  it("acks a bare approval reply with the approve/clear commands when a pending entry exists for the channel", async () => {
    const f = pendingFile();
    await recordPendingApproval(f, entry({ id: "go" }));
    const ack = await handleInboundApprovalReply({ pendingFile: f, providerId: "telegram", source: "42", text: "yes" });
    expect(ack).toContain("web_action");
    expect(ack).toContain("muse approvals approve go");
    expect(ack).toContain("muse approvals clear go");
  });

  it("returns undefined (let the agent handle it) for a non-approval message", async () => {
    const f = pendingFile();
    await recordPendingApproval(f, entry());
    expect(await handleInboundApprovalReply({ pendingFile: f, providerId: "telegram", source: "42", text: "what does it say?" })).toBeUndefined();
  });

  it("returns undefined when an approval reply has no pending action for this channel", async () => {
    const f = pendingFile();
    expect(await handleInboundApprovalReply({ pendingFile: f, providerId: "telegram", source: "42", text: "yes" })).toBeUndefined();
  });

  it("scopes to the channel: a pending entry for a different source is ignored", async () => {
    const f = pendingFile();
    await recordPendingApproval(f, entry({ id: "other", source: "99" }));
    expect(await handleInboundApprovalReply({ pendingFile: f, providerId: "telegram", source: "42", text: "approve" })).toBeUndefined();
  });

  it("ignores an expired pending entry", async () => {
    const f = pendingFile();
    await recordPendingApproval(f, entry({
      createdAt: "2019-12-31T23:59:00.000Z",
      expiresAt: "2020-01-01T00:00:00.000Z",
      id: "stale"
    }));
    expect(await handleInboundApprovalReply({ pendingFile: f, providerId: "telegram", source: "42", text: "yes" })).toBeUndefined();
  });

  it("never exposes or runs an injected executor; inbound yes only acknowledges the CLI-by-id path", async () => {
    const f = pendingFile();
    await recordPendingApproval(f, entry({ id: "go" }));
    const autoRun = vi.fn(async () => ({ ran: true }));
    const reply = await handleInboundApprovalReply({
      // @ts-expect-error inbound approval replies intentionally accept no executor
      autoRun,
      pendingFile: f,
      providerId: "telegram",
      source: "42",
      text: "yes"
    });
    expect(autoRun).not.toHaveBeenCalled();
    expect(reply).toContain("muse approvals approve go");
    expect((await listPendingApprovals(f)).map((e) => e.id)).toEqual(["go"]);
  });
});
