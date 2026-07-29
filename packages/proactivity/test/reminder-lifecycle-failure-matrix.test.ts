import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MessagingProviderRegistry,
  readOutboundEffect,
  type MessagingProvider,
  type OutboundMessage,
  type OutboundReceipt
} from "@muse/messaging";
import {
  confirmReminderTriage,
  previewReminderTriage,
  readReminders,
  writeReminders,
  type PersistedReminder
} from "@muse/stores";
import { afterEach, describe, expect, it } from "vitest";

import {
  reminderOccurrenceEffectId,
  runDueReminders
} from "../src/reminder-firing-loop.js";

const DUE_AT = "2026-07-28T23:00:00.000Z";
const NOW = "2026-07-29T00:00:00.000Z";
const cleanup: string[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "muse-reminder-failure-matrix-"));
  cleanup.push(dir);
  return {
    effectFile: join(dir, "outbound-effects.json"),
    historyFile: join(dir, "reminder-history.json"),
    ledgerFile: join(dir, "reminder-triage.json"),
    remindersFile: join(dir, "reminders.json")
  };
}

function reminder(overrides: Partial<PersistedReminder> = {}): PersistedReminder {
  return {
    createdAt: "2026-07-28T20:00:00.000Z",
    dueAt: DUE_AT,
    id: "rem-failure-matrix",
    status: "pending",
    text: "Take the medication now.",
    ...overrides
  };
}

function registry(
  send: (message: OutboundMessage) => Promise<OutboundReceipt>
): MessagingProviderRegistry {
  const provider: MessagingProvider = {
    describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
    id: "telegram",
    send
  };
  return new MessagingProviderRegistry([provider]);
}

function firingOptions(
  paths: ReturnType<typeof fixture>,
  messaging: MessagingProviderRegistry
) {
  return {
    destination: "@owner",
    effectFile: paths.effectFile,
    file: paths.remindersFile,
    historyFile: paths.historyFile,
    now: () => new Date(NOW),
    providerId: "telegram",
    registry: messaging
  } as const;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("reminder cancel, retry, and stale-state failure matrix", () => {
  it("keeps cancellation silent, retry idempotent, and stale confirmation non-successful", async () => {
    const cancelled = fixture();
    await writeReminders(cancelled.remindersFile, [reminder()]);
    const cancelPreview = await previewReminderTriage({
      action: "dismiss",
      ids: ["rem-failure-matrix"],
      ledgerFile: cancelled.ledgerFile,
      now: () => new Date(NOW),
      remindersFile: cancelled.remindersFile
    });
    const cancelReceipt = await confirmReminderTriage({
      ledgerFile: cancelled.ledgerFile,
      now: () => new Date(NOW),
      remindersFile: cancelled.remindersFile,
      token: cancelPreview.confirmToken
    });
    let cancellationProviderCalls = 0;
    const afterCancellation = await runDueReminders(firingOptions(
      cancelled,
      registry(async (message) => {
        cancellationProviderCalls += 1;
        return {
          destination: message.destination,
          messageId: "must-not-send-cancelled",
          providerId: "telegram"
        };
      })
    ));

    const retry = fixture();
    await writeReminders(retry.remindersFile, [reminder()]);
    let retryProviderCalls = 0;
    const firstAttempt = await runDueReminders(firingOptions(
      retry,
      registry(async () => {
        retryProviderCalls += 1;
        throw new Error("ambiguous provider timeout");
      })
    ));
    const callsAfterFirstAttempt = retryProviderCalls;
    const retryAttempt = await runDueReminders(firingOptions(
      retry,
      registry(async (message) => {
        retryProviderCalls += 1;
        return {
          destination: message.destination,
          messageId: "must-not-duplicate",
          providerId: "telegram"
        };
      })
    ));
    const retryEffect = await readOutboundEffect(
      retry.effectFile,
      reminderOccurrenceEffectId("rem-failure-matrix", DUE_AT)
    );

    const stale = fixture();
    await writeReminders(stale.remindersFile, [reminder()]);
    const stalePreview = await previewReminderTriage({
      action: "dismiss",
      ids: ["rem-failure-matrix"],
      ledgerFile: stale.ledgerFile,
      now: () => new Date(NOW),
      remindersFile: stale.remindersFile
    });
    const newerReminder = reminder({
      dueAt: "2026-07-29T01:00:00.000Z",
      text: "Owner changed this reminder after preview."
    });
    await writeReminders(stale.remindersFile, [newerReminder]);
    const staleReceipt = await confirmReminderTriage({
      ledgerFile: stale.ledgerFile,
      now: () => new Date(NOW),
      remindersFile: stale.remindersFile,
      token: stalePreview.confirmToken
    });
    const afterStaleConfirmation = await readReminders(stale.remindersFile);
    expect(afterStaleConfirmation).toEqual([newerReminder]);

    expect({
      cancellation: {
        delivered: afterCancellation.delivered,
        due: afterCancellation.due,
        effectCreated: existsSync(cancelled.effectFile),
        providerCalls: cancellationProviderCalls,
        receiptStatus: cancelReceipt.status
      },
      retry: {
        duplicateProviderCalls: retryProviderCalls - callsAfterFirstAttempt,
        firstProviderCalls: callsAfterFirstAttempt,
        firstDelivered: firstAttempt.delivered,
        retryDelivered: retryAttempt.delivered,
        retryEffectState: retryEffect?.state
      },
      stale: {
        appliedTransitions: staleReceipt.status === "applied" ? 1 : 0,
        outcome: staleReceipt.outcome,
        statePreserved: afterStaleConfirmation.length === 1
          && afterStaleConfirmation[0]?.dueAt === newerReminder.dueAt
          && afterStaleConfirmation[0]?.status === newerReminder.status
          && afterStaleConfirmation[0]?.text === newerReminder.text,
        status: staleReceipt.status
      }
    }).toEqual({
      cancellation: {
        delivered: 0,
        due: 0,
        effectCreated: false,
        providerCalls: 0,
        receiptStatus: "applied"
      },
      retry: {
        duplicateProviderCalls: 0,
        firstProviderCalls: 1,
        firstDelivered: 0,
        retryDelivered: 0,
        retryEffectState: "unknown"
      },
      stale: {
        appliedTransitions: 0,
        outcome: "snapshot-drift",
        statePreserved: true,
        status: "conflict"
      }
    });
  });
});
