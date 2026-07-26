import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GmailEmailProvider,
  sendEmailWithApproval,
  type EmailSender
} from "@muse/domain-tools";
import {
  dispatchOutboundEffectOnce,
  MessagingProviderRegistry,
  readOutboundEffect,
  type MessagingProvider,
  type OutboundMessage,
  type OutboundReceipt
} from "@muse/messaging";
import {
  authorizeFollowupTriage,
  confirmFollowupTriage,
  readFollowupsStrict,
  writeFollowups,
  type PersistedFollowup
} from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  lockDaemonMessagingRegistry,
  resolveDaemonProviderLock
} from "./daemon-messaging-safety.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const CONTACTS = [{ email: "owner-approved@example.com", id: "approved", name: "Approved" }] as const;

interface FaultCounters {
  readonly silentDelete: number;
  readonly silentReschedule: number;
  readonly unapprovedSend: number;
}

interface FaultProbe {
  readonly actionLogFile: string;
  readonly effectFile: string;
  readonly followupsFile: string;
  readonly triageLedgerFile: string;
  providerCall(): void;
  withOwnerApproval<T>(operation: () => Promise<T>): Promise<T>;
  counters(): Promise<FaultCounters>;
}

interface FaultOutcome {
  readonly terminalState: string;
}

interface FaultCase {
  readonly name:
    | "restart"
    | "stale-config"
    | "backlog"
    | "retry"
    | "partial-receipt"
    | "provider-failure";
  readonly run: (probe: FaultProbe) => Promise<FaultOutcome>;
}

function followup(): PersistedFollowup {
  return {
    createdAt: "2026-07-01T00:00:00.000Z",
    id: "backlog-1",
    scheduledFor: "2026-07-20T00:00:00.000Z",
    status: "scheduled",
    summary: "private backlog sentinel",
    userId: "owner"
  };
}

async function faultProbe(): Promise<FaultProbe> {
  const dir = await mkdtemp(join(tmpdir(), "muse-g2-fault-campaign-"));
  const followupsFile = join(dir, "followups.json");
  const initial = followup();
  await writeFollowups(followupsFile, [initial]);
  let ownerApprovalActive = false;
  let unapprovedSend = 0;

  return {
    actionLogFile: join(dir, "action-log.json"),
    effectFile: join(dir, "outbound-effects.json"),
    followupsFile,
    triageLedgerFile: join(dir, "followup-triage.json"),
    providerCall: () => {
      if (!ownerApprovalActive) unapprovedSend += 1;
    },
    withOwnerApproval: async <T>(operation: () => Promise<T>): Promise<T> => {
      ownerApprovalActive = true;
      try {
        return await operation();
      } finally {
        ownerApprovalActive = false;
      }
    },
    counters: async () => {
      const current = await readFollowupsStrict(followupsFile);
      const item = current.find((candidate) => candidate.id === initial.id);
      return {
        silentDelete: item === undefined || item.status !== initial.status ? 1 : 0,
        silentReschedule: item !== undefined && item.scheduledFor !== initial.scheduledFor ? 1 : 0,
        unapprovedSend
      };
    }
  };
}

function emailOptions(probe: FaultProbe, sender: EmailSender, effectId: string) {
  return {
    actionLogFile: probe.actionLogFile,
    approvalGate: () => ({ approved: true as const }),
    body: "Exact approved body",
    contacts: CONTACTS,
    effectFile: probe.effectFile,
    effectId,
    recipientQuery: "Approved",
    sender,
    subject: "Exact approved subject",
    userId: "owner"
  };
}

function provider(
  id: string,
  send: (message: OutboundMessage) => Promise<OutboundReceipt>
): MessagingProvider {
  return {
    describe: () => ({ description: id, displayName: id, id }),
    id,
    send
  };
}

const CASES: readonly FaultCase[] = [
  {
    name: "restart",
    run: async (probe) => {
      const sender: EmailSender = {
        sendEmail: async () => {
          probe.providerCall();
          return "accepted-before-restart";
        }
      };
      await probe.withOwnerApproval(() =>
        sendEmailWithApproval(emailOptions(probe, sender, "restart-effect"))
      );
      const replay = await sendEmailWithApproval({
        ...emailOptions(probe, sender, "restart-effect"),
        approvalGate: () => ({ approved: false as const, reason: "no new owner approval" })
      });
      expect(replay).toMatchObject({ reason: "denied", sent: false });
      expect(await readOutboundEffect(probe.effectFile, "restart-effect")).toMatchObject({
        state: "accepted"
      });
      return { terminalState: "accepted-no-replay" };
    }
  },
  {
    name: "stale-config",
    run: async (probe) => {
      const registry = new MessagingProviderRegistry([
        provider("telegram", async (message) => {
          probe.providerCall();
          return {
            destination: message.destination,
            messageId: "must-not-send",
            providerId: "telegram"
          };
        })
      ]);
      const staleLock = resolveDaemonProviderLock({ MUSE_DAEMON_PROVIDER_LOCK: "log" });
      const locked = lockDaemonMessagingRegistry(registry, staleLock);
      const result = await dispatchOutboundEffectOnce({
        destination: "external-recipient",
        effectFile: probe.effectFile,
        effectId: "stale-config-effect",
        now: () => NOW,
        providerId: "telegram",
        registry: locked,
        text: "prepared under a stale provider route"
      });
      expect(result).toMatchObject({ state: "unknown" });
      return { terminalState: "unknown-provider-lock-mismatch" };
    }
  },
  {
    name: "backlog",
    run: async (probe) => {
      const authorization = await authorizeFollowupTriage({
        action: "dismiss",
        followupsFile: probe.followupsFile,
        ids: ["backlog-1"],
        ledgerFile: probe.triageLedgerFile,
        now: () => NOW
      });
      const secretOffset = `ft1_${authorization.operationId}_`.length;
      const replacement = authorization.confirmToken[secretOffset] === "A" ? "B" : "A";
      const forged = `${authorization.confirmToken.slice(0, secretOffset)}${replacement}${authorization.confirmToken.slice(secretOffset + 1)}`;
      await expect(confirmFollowupTriage({
        followupsFile: probe.followupsFile,
        ledgerFile: probe.triageLedgerFile,
        now: () => NOW,
        token: forged
      })).rejects.toThrow("invalid follow-up triage token");
      return { terminalState: "rejected-invalid-owner-authorization" };
    }
  },
  {
    name: "retry",
    run: async (probe) => {
      let calls = 0;
      const sender = new GmailEmailProvider("synthetic-token", (async () => {
        probe.providerCall();
        calls += 1;
        return calls < 3
          ? new Response("rate limited", { status: 429 })
          : new Response(JSON.stringify({ id: "accepted-after-safe-retry" }), { status: 200 });
      }) as typeof globalThis.fetch, {
        baseDelayMs: 0,
        retries: 2,
        sleep: async () => undefined
      });
      const result = await probe.withOwnerApproval(() =>
        sendEmailWithApproval(emailOptions(probe, sender, "retry-effect"))
      );
      expect(result).toMatchObject({ messageId: "accepted-after-safe-retry", sent: true });
      expect(calls).toBe(3);
      return { terminalState: "accepted-after-preaccept-retry" };
    }
  },
  {
    name: "partial-receipt",
    run: async (probe) => {
      const registry = new MessagingProviderRegistry([
        provider("log", async (message) => {
          probe.providerCall();
          return { destination: message.destination, messageId: "", providerId: "log" };
        })
      ]);
      const first = await probe.withOwnerApproval(() =>
        dispatchOutboundEffectOnce({
          destination: "local",
          effectFile: probe.effectFile,
          effectId: "partial-receipt-effect",
          now: () => NOW,
          providerId: "log",
          registry,
          text: "approved local payload"
        })
      );
      expect(first).toMatchObject({ state: "unknown" });
      expect(await dispatchOutboundEffectOnce({
        destination: "local",
        effectFile: probe.effectFile,
        effectId: "partial-receipt-effect",
        now: () => NOW,
        providerId: "log",
        registry,
        text: "approved local payload"
      })).toMatchObject({ state: "unknown" });
      return { terminalState: "unknown-no-retry-after-partial-receipt" };
    }
  },
  {
    name: "provider-failure",
    run: async (probe) => {
      const registry = new MessagingProviderRegistry([
        provider("log", async () => {
          probe.providerCall();
          throw new Error("synthetic provider failure");
        })
      ]);
      const first = await probe.withOwnerApproval(() =>
        dispatchOutboundEffectOnce({
          destination: "local",
          effectFile: probe.effectFile,
          effectId: "provider-failure-effect",
          now: () => NOW,
          providerId: "log",
          registry,
          text: "approved local payload"
        })
      );
      expect(first).toMatchObject({ state: "unknown" });
      expect(await dispatchOutboundEffectOnce({
        destination: "local",
        effectFile: probe.effectFile,
        effectId: "provider-failure-effect",
        now: () => NOW,
        providerId: "log",
        registry,
        text: "approved local payload"
      })).toMatchObject({ state: "unknown" });
      return { terminalState: "unknown-no-retry-after-provider-failure" };
    }
  }
];

describe("G2 zero-unapproved-send fault campaign", () => {
  it.each(CASES)(
    "$name keeps every unapproved or silent effect counter at zero",
    async ({ run }) => {
      const probe = await faultProbe();
      const outcome = await run(probe);

      expect(outcome.terminalState).not.toBe("");
      expect(await probe.counters()).toEqual({
        silentDelete: 0,
        silentReschedule: 0,
        unapprovedSend: 0
      });
    }
  );
});
