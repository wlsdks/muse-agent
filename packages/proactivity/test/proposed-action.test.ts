import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { queryActionLog } from "@muse/stores";
import { isProposalActionable, proposeMessageAction, readProposedActions } from "@muse/stores";
import { confirmProposedAction, declineProposedAction } from "../src/proposed-action-confirm.js";

function capturing(sent: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
    }
  };
}

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "muse-propose-"));
  return { actionLogFile: join(dir, "action-log.json"), file: join(dir, "proposed.json") };
}

const draft = {
  destination: "555",
  providerId: "telegram",
  reason: "calendar conflict detected — proposed a reschedule note",
  summary: "Tell Sam standup moves to 10am",
  text: "Heads up — standup moves to 10am tomorrow.",
  userId: "stark"
} as const;

describe("proposed actions — draft-first, confirm-to-execute (outbound-safety)", () => {
  it("proposing persists a pending action and sends NOTHING", async () => {
    const { actionLogFile, file } = paths();
    void actionLogFile;
    const proposal = await proposeMessageAction(file, draft);

    expect(proposal.status).toBe("pending");
    const stored = await readProposedActions(file);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe("pending");
    expect(stored[0]!.text).toContain("standup moves to 10am");
  });

  it("confirm executes exactly once: sends, flips to executed, logs performed", async () => {
    const { actionLogFile, file } = paths();
    const proposal = await proposeMessageAction(file, draft);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturing(sent)]);

    const first = await confirmProposedAction({ actionLogFile, file, id: proposal.id, registry });
    expect(first).toMatchObject({ executed: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.destination).toBe("555");
    expect((await readProposedActions(file))[0]!.status).toBe("executed");
    const log = await queryActionLog(actionLogFile, {});
    expect(log[0]).toMatchObject({ result: "performed", userId: "stark" });

    // replay guard: a second approve does NOT send again
    const second = await confirmProposedAction({ actionLogFile, file, id: proposal.id, registry });
    expect(second).toMatchObject({ executed: false });
    expect(sent).toHaveLength(1);
  });

  it("decline flips to declined, sends NOTHING, logs a refusal", async () => {
    const { actionLogFile, file } = paths();
    const proposal = await proposeMessageAction(file, draft);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturing(sent)]);

    const res = await declineProposedAction({ actionLogFile, file, id: proposal.id });
    expect(res).toMatchObject({ declined: true });
    expect((await readProposedActions(file))[0]!.status).toBe("declined");
    expect((await queryActionLog(actionLogFile, {}))[0]).toMatchObject({ result: "refused" });

    // a declined proposal can't then be confirmed (no send)
    const after = await confirmProposedAction({ actionLogFile, file, id: proposal.id, registry });
    expect(after).toMatchObject({ executed: false });
    expect(sent).toHaveLength(0);
  });

  it("an expired proposal is inert: not actionable, and confirm refuses without sending", async () => {
    const { actionLogFile, file } = paths();
    // ttl 1ms + a now() in the past → already expired by the time we confirm.
    const proposal = await proposeMessageAction(file, { ...draft, now: () => new Date(Date.now() - 60_000), ttlMs: 1 });
    expect(isProposalActionable(proposal, new Date())).toBe(false);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturing(sent)]);

    const res = await confirmProposedAction({ actionLogFile, file, id: proposal.id, registry });
    expect(res).toMatchObject({ executed: false, reason: "expired" });
    expect(sent).toHaveLength(0);
    expect((await readProposedActions(file))[0]!.status).toBe("pending"); // unchanged, just inert
  });

  it("a fresh proposal is actionable within its TTL", async () => {
    const { file } = paths();
    const proposal = await proposeMessageAction(file, draft);
    expect(typeof proposal.expiresAt).toBe("string");
    expect(isProposalActionable(proposal, new Date())).toBe(true);
  });

  it("a send failure leaves the proposal pending (retryable) and logs failed", async () => {
    const { actionLogFile, file } = paths();
    const proposal = await proposeMessageAction(file, draft);
    const throwing: MessagingProvider = {
      describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
      id: "telegram",
      async send(): Promise<OutboundReceipt> { throw new Error("network down"); }
    };
    const registry = new MessagingProviderRegistry([throwing]);

    const res = await confirmProposedAction({ actionLogFile, file, id: proposal.id, registry });
    expect(res).toMatchObject({ executed: false });
    expect((await readProposedActions(file))[0]!.status).toBe("pending");
    expect((await queryActionLog(actionLogFile, {}))[0]).toMatchObject({ result: "failed" });
  });

  it("two concurrent confirms of the same pending proposal send EXACTLY once", async () => {
    const { actionLogFile, file } = paths();
    const proposal = await proposeMessageAction(file, draft);
    const sent: OutboundMessage[] = [];
    // A send that yields control before recording, so two unguarded confirms
    // would both clear the pending check and both send (the double-send bug).
    const slow: MessagingProvider = {
      describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
      id: "telegram",
      async send(message: OutboundMessage): Promise<OutboundReceipt> {
        await new Promise((resolve) => setTimeout(resolve, 5));
        sent.push(message);
        return { destination: message.destination, messageId: "m1", providerId: "telegram" };
      }
    };
    const registry = new MessagingProviderRegistry([slow]);

    const [first, second] = await Promise.all([
      confirmProposedAction({ actionLogFile, file, id: proposal.id, registry }),
      confirmProposedAction({ actionLogFile, file, id: proposal.id, registry })
    ]);

    expect(sent).toHaveLength(1);
    const executed = [first, second].filter((r) => r.executed);
    const refused = [first, second].filter((r) => !r.executed);
    expect(executed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ executed: false, reason: "already executed" });
    expect((await readProposedActions(file))[0]!.status).toBe("executed");
    const performed = (await queryActionLog(actionLogFile, {})).filter((e) => e.result === "performed");
    expect(performed).toHaveLength(1);
  });
});
