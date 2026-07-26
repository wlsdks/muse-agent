import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  MessagingProviderRegistry,
  computeOutboundEffectPayloadHash,
  prepareOutboundEffect,
  readOutboundEffect,
  readOutboundEffects,
  reconcileOutboundEffect,
  type MessagingProvider,
  type OutboundMessage,
  type OutboundReceipt
} from "@muse/messaging";
import {
  readReminderHistory,
  readReminders,
  writeReminders,
  type PersistedReminder
} from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  reminderOccurrenceEffectId,
  runDueReminders
} from "../src/reminder-firing-loop.js";

const DUE_AT = "2026-07-26T23:00:00.000Z";
const NOW = "2026-07-27T00:00:00.000Z";
const execFileAsync = promisify(execFile);
const childFixture = new URL("./fixtures/reminder-firing-effect-child.ts", import.meta.url);

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "muse-reminder-effect-"));
  return {
    dir,
    effectFile: join(dir, "outbound-effects.json"),
    historyFile: join(dir, "reminder-history.json"),
    remindersFile: join(dir, "reminders.json")
  };
}

function reminder(over: Partial<PersistedReminder> = {}): PersistedReminder {
  return {
    createdAt: "2026-07-26T20:00:00.000Z",
    dueAt: DUE_AT,
    id: "rem-effect-1",
    status: "pending",
    text: "Take the medication now.",
    ...over
  };
}

function registry(
  send: (message: OutboundMessage) => Promise<OutboundReceipt>,
  providerId = "telegram"
): MessagingProviderRegistry {
  const provider: MessagingProvider = {
    describe: () => ({ description: "test", displayName: "Test", id: providerId }),
    id: providerId,
    send
  };
  return new MessagingProviderRegistry([provider]);
}

function options(
  p: ReturnType<typeof paths>,
  messaging: MessagingProviderRegistry,
  now: () => Date = () => new Date(NOW)
) {
  return {
    destination: "@owner",
    effectFile: p.effectFile,
    file: p.remindersFile,
    historyFile: p.historyFile,
    now,
    providerId: "telegram",
    registry: messaging
  } as const;
}

describe("runDueReminders durable occurrence effect", () => {
  it("binds one exact occurrence and records accepted history before firing", async () => {
    const p = paths();
    await writeReminders(p.remindersFile, [reminder()]);
    const sent: OutboundMessage[] = [];
    const summary = await runDueReminders(options(p, registry(async (message) => {
      sent.push(message);
      return { destination: message.destination, messageId: "accepted-1", providerId: "telegram" };
    })));

    expect(summary.delivered).toBe(1);
    expect(sent).toEqual([
      expect.objectContaining({
        destination: "@owner",
        idempotencyKey: reminderOccurrenceEffectId("rem-effect-1", DUE_AT),
        text: "Take the medication now."
      })
    ]);
    expect((await readReminders(p.remindersFile))[0]!.status).toBe("fired");
    expect(await readReminderHistory(p.historyFile)).toEqual([
      expect.objectContaining({
        effectId: reminderOccurrenceEffectId("rem-effect-1", DUE_AT),
        firedAtIso: NOW,
        reminderId: "rem-effect-1",
        status: "delivered",
        text: "Take the medication now."
      })
    ]);
    expect(await readOutboundEffect(
      p.effectFile,
      reminderOccurrenceEffectId("rem-effect-1", DUE_AT)
    )).toMatchObject({ state: "accepted" });
  });

  it("seals provider failure and crash-left prepared as unknown with zero automatic replay", async () => {
    const p = paths();
    await writeReminders(p.remindersFile, [reminder()]);
    let calls = 0;
    const failing = registry(async () => {
      calls += 1;
      throw new Error("ambiguous timeout");
    });
    const first = await runDueReminders(options(p, failing));
    const replay = await runDueReminders(options(p, registry(async () => {
      calls += 1;
      throw new Error("must not retry");
    })));
    expect(calls).toBe(1);
    expect(first.errors[0]).toContain("delivery is unknown");
    expect(replay.errors[0]).toContain("do not retry with a new effect ID");
    expect((await readReminders(p.remindersFile))[0]!.status).toBe("pending");

    const prepared = paths();
    const preparedReminder = reminder({ id: "rem-prepared" });
    await writeReminders(prepared.remindersFile, [preparedReminder]);
    const effectId = reminderOccurrenceEffectId(preparedReminder.id, preparedReminder.dueAt);
    await prepareOutboundEffect(prepared.effectFile, {
      createdAt: NOW,
      destination: "@owner",
      effectId,
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "@owner",
        providerId: "telegram",
        text: preparedReminder.text
      }),
      providerId: "telegram"
    });
    let preparedCalls = 0;
    const preparedResult = await runDueReminders(options(prepared, registry(async () => {
      preparedCalls += 1;
      throw new Error("must not dispatch prepared");
    })));
    expect(preparedCalls).toBe(0);
    expect(preparedResult.errors[0]).toContain("delivery is unknown");
    expect(await readOutboundEffect(prepared.effectFile, effectId)).toMatchObject({ state: "unknown" });
  });

  it("repairs post-receipt history and reminder-write failures with no resend or resynthesis", async () => {
    const historyFailure = paths();
    await writeReminders(historyFailure.remindersFile, [reminder()]);
    let historyCalls = 0;
    const historyRegistry = registry(async (message) => {
      historyCalls += 1;
      mkdirSync(historyFailure.historyFile);
      return { destination: message.destination, messageId: "history-repair", providerId: "telegram" };
    });
    const incompleteHistory = await runDueReminders(options(historyFailure, historyRegistry));
    expect(incompleteHistory.delivered).toBe(0);
    expect((await readReminders(historyFailure.remindersFile))[0]!.status).toBe("pending");
    rmSync(historyFailure.historyFile, { force: true, recursive: true });
    const repairedHistory = await runDueReminders(options(
      historyFailure,
      new MessagingProviderRegistry([])
    ));
    expect(repairedHistory.delivered).toBe(1);
    expect(historyCalls).toBe(1);
    expect(await readReminderHistory(historyFailure.historyFile)).toHaveLength(1);

    const writeFailure = paths();
    const original = reminder({ id: "rem-write-repair" });
    await writeReminders(writeFailure.remindersFile, [original]);
    const originalBytes = readFileSync(writeFailure.remindersFile, "utf8");
    let sends = 0;
    let synthesis = 0;
    const activeOptions = {
      ...options(writeFailure, registry(async (message) => {
        sends += 1;
        rmSync(writeFailure.remindersFile);
        mkdirSync(writeFailure.remindersFile);
        return { destination: message.destination, messageId: "write-repair", providerId: "telegram" };
      })),
      activitySource: { lastActivityMs: () => Date.parse(NOW) },
      agentModel: "test-model",
      agentRuntime: {
        run: async () => {
          synthesis += 1;
          return { response: { output: "Synthesized exact reminder." } };
        }
      }
    };
    await expect(runDueReminders(activeOptions)).rejects.toThrow();
    rmSync(writeFailure.remindersFile, { force: true, recursive: true });
    writeFileSync(writeFailure.remindersFile, originalBytes);
    const repairedWrite = await runDueReminders({
      ...activeOptions,
      registry: new MessagingProviderRegistry([])
    });
    expect(repairedWrite.delivered).toBe(1);
    expect(sends).toBe(1);
    expect(synthesis).toBe(1);
    expect(await readReminderHistory(writeFailure.historyFile)).toHaveLength(1);
  });

  it("fires from an accepted receipt without fabricating synthesized history after append fault", async () => {
    const p = paths();
    const source = reminder({ id: "rem-synth-history-gap" });
    await writeReminders(p.remindersFile, [source]);
    const effectId = reminderOccurrenceEffectId(source.id, source.dueAt);
    let providerCalls = 0;
    let synthesisCalls = 0;
    const activeOptions = {
      ...options(p, registry(async (message) => {
        providerCalls += 1;
        mkdirSync(p.historyFile);
        return { destination: message.destination, messageId: "synth-history-gap", providerId: "telegram" };
      })),
      activitySource: { lastActivityMs: () => Date.parse(NOW) },
      agentModel: "test-model",
      agentRuntime: {
        run: async () => {
          synthesisCalls += 1;
          return { response: { output: "Synthesized private delivery text." } };
        }
      }
    };

    const first = await runDueReminders(activeOptions);
    expect(first.delivered).toBe(0);
    expect((await readReminders(p.remindersFile))[0]!.status).toBe("pending");
    expect(await readOutboundEffect(p.effectFile, effectId)).toMatchObject({ state: "accepted" });

    rmSync(p.historyFile, { force: true, recursive: true });
    const replay = await runDueReminders(activeOptions);
    expect(replay.delivered).toBe(1);
    expect(replay.errors).toEqual([
      expect.stringContaining(`accepted effect ${effectId}`)
    ]);
    expect(replay.errors[0]!.length).toBeLessThanOrEqual(500);
    expect(replay.errors[0]).toContain("history remains absent");
    expect(providerCalls).toBe(1);
    expect(synthesisCalls).toBe(1);
    expect(await readReminderHistory(p.historyFile)).toEqual([]);
    expect(existsSync(p.historyFile)).toBe(false);
    expect((await readReminders(p.remindersFile))[0]!.status).toBe("fired");
    expect(await readOutboundEffect(p.effectFile, effectId)).toMatchObject({ state: "accepted" });
  });

  it("applies manual accepted reconciliation and blocks not-delivered without resending", async () => {
    const accepted = paths();
    await writeReminders(accepted.remindersFile, [reminder()]);
    let acceptedCalls = 0;
    await runDueReminders(options(accepted, registry(async () => {
      acceptedCalls += 1;
      throw new Error("unknown acceptance");
    })));
    const acceptedEffectId = reminderOccurrenceEffectId("rem-effect-1", DUE_AT);
    await reconcileOutboundEffect(accepted.effectFile, {
      actor: "owner",
      decision: "accepted",
      effectId: acceptedEffectId,
      reason: "found exact provider receipt",
      receipt: {
        destination: "@owner",
        messageId: "manual-accepted",
        providerId: "telegram",
        receivedAt: "2026-07-27T00:00:01.000Z"
      },
      recordedAt: "2026-07-27T00:00:01.000Z"
    });
    const acceptedResult = await runDueReminders(options(
      accepted,
      new MessagingProviderRegistry([])
    ));
    expect(acceptedResult.delivered).toBe(1);
    expect(acceptedCalls).toBe(1);
    expect((await readReminders(accepted.remindersFile))[0]).toMatchObject({
      firedAt: "2026-07-27T00:00:01.000Z",
      status: "fired"
    });

    const rejected = paths();
    await writeReminders(rejected.remindersFile, [reminder()]);
    let rejectedCalls = 0;
    await runDueReminders(options(rejected, registry(async () => {
      rejectedCalls += 1;
      throw new Error("unknown acceptance");
    })));
    const rejectedEffectId = reminderOccurrenceEffectId("rem-effect-1", DUE_AT);
    await reconcileOutboundEffect(rejected.effectFile, {
      actor: "owner",
      decision: "not-delivered",
      effectId: rejectedEffectId,
      reason: "provider history has no matching message",
      recordedAt: "2026-07-27T00:00:01.000Z"
    });
    const rejectedResult = await runDueReminders(options(rejected, registry(async () => {
      rejectedCalls += 1;
      throw new Error("must not resend not-delivered");
    })));
    expect(rejectedResult.delivered).toBe(0);
    expect(rejectedResult.errors[0]).toContain("create or reschedule a new reminder");
    expect(rejectedCalls).toBe(1);
    expect((await readReminders(rejected.remindersFile))[0]!.status).toBe("pending");
  });

  it("uses a distinct history effect for recurring occurrences even when receipt timestamps coincide", async () => {
    const p = paths();
    await writeReminders(p.remindersFile, [reminder({ recurrence: "daily" })]);
    let calls = 0;
    const transport = registry(async (message) => {
      calls += 1;
      return { destination: message.destination, messageId: `recurring-${calls.toString()}`, providerId: "telegram" };
    });
    await runDueReminders(options(p, transport));
    const afterFirst = (await readReminders(p.remindersFile))[0]!;
    expect(afterFirst.status).toBe("pending");
    expect(afterFirst.dueAt).not.toBe(DUE_AT);
    await runDueReminders(options(p, transport));
    expect(calls).toBe(1);

    // The due filter observes a later tick, while the provider receipt clock is
    // deliberately pinned to the first receipt instant. Distinct occurrences
    // must not collapse merely because every legacy history identity field
    // (including firedAtIso) is equal.
    const secondTickTimes = [
      "2026-07-30T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z",
      NOW,
      NOW
    ];
    let clockRead = 0;
    await runDueReminders(options(p, transport, () =>
      new Date(secondTickTimes[Math.min(clockRead++, secondTickTimes.length - 1)]!)
    ));
    expect(calls).toBe(2);
    const effects = await readOutboundEffects(p.effectFile);
    const occurrenceEffectIds = [
      reminderOccurrenceEffectId("rem-effect-1", DUE_AT),
      reminderOccurrenceEffectId("rem-effect-1", afterFirst.dueAt)
    ];
    expect(effects.map(({ binding }) => binding.effectId)).toEqual(occurrenceEffectIds);
    const history = await readReminderHistory(p.historyFile);
    expect(history).toHaveLength(2);
    expect(history.map(({ effectId }) => effectId).sort()).toEqual([...occurrenceEffectIds].sort());
    expect(history.map(({ firedAtIso }) => firedAtIso)).toEqual([NOW, NOW]);
  });

  it("prevalidates route and strict history before any effect or provider call", async () => {
    const p = paths();
    await writeReminders(p.remindersFile, [reminder()]);
    let calls = 0;
    let synthesis = 0;
    const missingRoute = await runDueReminders({
      ...options(p, new MessagingProviderRegistry([]), () => new Date(NOW)),
      activitySource: { lastActivityMs: () => Date.parse(NOW) },
      agentModel: "test-model",
      agentRuntime: {
        run: async () => {
          synthesis += 1;
          return { response: { output: "must not synthesize" } };
        }
      }
    });
    expect(missingRoute.errors[0]).toContain("route is unavailable");
    expect(calls).toBe(0);
    expect(synthesis).toBe(0);
    expect(existsSync(p.effectFile)).toBe(false);

    writeFileSync(p.historyFile, "{corrupt", { mode: 0o600 });
    const corruptHistory = await runDueReminders(options(p, registry(async () => {
      calls += 1;
      throw new Error("must not send");
    })));
    expect(corruptHistory.errors[0]).toContain("history is corrupt");
    expect(calls).toBe(0);
    expect(existsSync(p.effectFile)).toBe(false);
  });

  it("does not fabricate history when an accepted payload cannot be reconstructed after drift", async () => {
    const p = paths();
    const original = reminder();
    await writeReminders(p.remindersFile, [original]);
    let calls = 0;
    await runDueReminders({
      ...options(p, registry(async (message) => {
        calls += 1;
        return { destination: message.destination, messageId: "accepted-before-drift", providerId: "telegram" };
      })),
      historyFile: undefined
    });
    await writeReminders(p.remindersFile, [{ ...original, text: "Mutated reminder text" }]);
    const repair = await runDueReminders(options(p, registry(async () => {
      calls += 1;
      throw new Error("must not resend drift");
    })));
    expect(repair.delivered).toBe(1);
    expect(repair.errors[0]).toContain("provider receipt is authoritative");
    expect(repair.errors[0]).toContain("history remains absent");
    expect(calls).toBe(1);
    expect(await readReminderHistory(p.historyFile)).toEqual([]);
    expect((await readReminders(p.remindersFile))[0]!.status).toBe("fired");
  });

  it("admits at most one provider call across two reminder processes", async () => {
    const p = paths();
    await writeReminders(p.remindersFile, [reminder()]);
    const callsFile = join(p.dir, "provider-calls.txt");
    const input = {
      callsFile,
      effectFile: p.effectFile,
      historyFile: p.historyFile,
      nowIso: NOW,
      remindersFile: p.remindersFile
    };
    await Promise.all([
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        childFixture.pathname,
        JSON.stringify(input)
      ]),
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        childFixture.pathname,
        JSON.stringify(input)
      ])
    ]);
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    expect(calls).toHaveLength(1);
    expect((await readReminders(p.remindersFile))[0]!.status).toBe("fired");
    expect(await readReminderHistory(p.historyFile)).toHaveLength(1);
    expect(await readOutboundEffects(p.effectFile)).toHaveLength(1);
  }, 20_000);
});
