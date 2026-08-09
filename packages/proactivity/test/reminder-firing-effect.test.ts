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
import { fileURLToPath } from "node:url";
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
  buildReminderTriggerEnvelope,
  reminderOccurrenceEffectId,
  runDueReminders
} from "../src/reminder-firing-loop.js";

const DUE_AT = "2026-07-26T23:00:00.000Z";
const NOW = "2026-07-27T00:00:00.000Z";
const execFileAsync = promisify(execFile);
const childFixture = fileURLToPath(new URL("./fixtures/reminder-firing-effect-child.ts", import.meta.url));

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
  it("filters an exact selected reminder under lock and leaves every other due reminder untouched", async () => {
    const p = paths();
    await writeReminders(p.remindersFile, [
      reminder({ id: "rem-selected", text: "Selected reminder" }),
      reminder({ id: "rem-unselected", text: "Must remain pending" })
    ]);
    const sent: OutboundMessage[] = [];

    const summary = await runDueReminders({
      ...options(p, registry(async (message) => {
        sent.push(message);
        return { destination: message.destination, messageId: "accepted-selected", providerId: "telegram" };
      })),
      allowedProviderIds: ["telegram"],
      reminderId: "rem-selected"
    });

    expect(summary).toMatchObject({ delivered: 1, due: 1, errors: [] });
    expect(sent.map(({ text }) => text)).toEqual(["Selected reminder"]);
    expect((await readReminders(p.remindersFile)).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "rem-selected", status: "fired" },
      { id: "rem-unselected", status: "pending" }
    ]);
    expect(await readOutboundEffects(p.effectFile)).toHaveLength(1);
    expect(await readReminderHistory(p.historyFile)).toEqual([
      expect.objectContaining({ reminderId: "rem-selected", status: "delivered" })
    ]);
  });

  it("rejects a missing exact selection and a disallowed per-reminder route before effects or mutation", async () => {
    const p = paths();
    await writeReminders(p.remindersFile, [reminder()]);
    const original = readFileSync(p.remindersFile, "utf8");
    let providerCalls = 0;
    const messaging = registry(async (message) => {
      providerCalls += 1;
      return { destination: message.destination, messageId: "must-not-send", providerId: "telegram" };
    });

    await expect(runDueReminders({
      ...options(p, messaging),
      allowedProviderIds: ["telegram"],
      reminderId: "rem-missing"
    })).rejects.toThrow("selected reminder not found");

    await writeReminders(p.remindersFile, [
      reminder({ via: { destination: "remote-destination", providerId: "slack" } })
    ]);
    const overridden = readFileSync(p.remindersFile, "utf8");
    await expect(runDueReminders({
      ...options(p, messaging),
      allowedProviderIds: ["telegram"],
      reminderId: "rem-effect-1"
    })).rejects.toThrow("provider 'slack' is not permitted");

    expect(original).not.toBe(overridden);
    expect(readFileSync(p.remindersFile, "utf8")).toBe(overridden);
    expect(providerCalls).toBe(0);
    expect(existsSync(p.effectFile)).toBe(false);
    expect(existsSync(p.historyFile)).toBe(false);
  });

  it("rejects a provider allowlist without an exact selection before store mutation or effects", async () => {
    const p = paths();
    await writeReminders(p.remindersFile, [reminder()]);
    const original = readFileSync(p.remindersFile, "utf8");
    let providerCalls = 0;

    await expect(runDueReminders({
      ...options(p, registry(async (message) => {
        providerCalls += 1;
        return { destination: message.destination, messageId: "must-not-send", providerId: "telegram" };
      })),
      allowedProviderIds: ["telegram"]
    })).rejects.toThrow("requires an exact selected reminder id");

    expect(readFileSync(p.remindersFile, "utf8")).toBe(original);
    expect(providerCalls).toBe(0);
    expect(existsSync(p.effectFile)).toBe(false);
    expect(existsSync(p.historyFile)).toBe(false);
  });

  it("binds one exact occurrence and records accepted history before firing", async () => {
    const p = paths();
    await writeReminders(p.remindersFile, [reminder()]);
    const sent: OutboundMessage[] = [];
    const summary = await runDueReminders(options(p, registry(async (message) => {
      sent.push(message);
      return { destination: message.destination, messageId: "accepted-1", providerId: "telegram" };
    })));

    expect(summary.delivered).toBe(1);
    expect(buildReminderTriggerEnvelope(reminder())).toEqual({
      dedupKey: reminderOccurrenceEffectId("rem-effect-1", DUE_AT),
      generation: DUE_AT,
      occurredAt: DUE_AT,
      provenance: { kind: "local-store", ref: "reminders" },
      receivedAt: DUE_AT,
      schemaVersion: 1,
      source: "reminder",
      sourceId: "rem-effect-1"
    });
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

  it("reuses one post-lock clock snapshot across a multi-reminder tick", async () => {
    const p = paths();
    await writeReminders(p.remindersFile, [
      reminder({ id: "rem-snapshot-1" }),
      reminder({ id: "rem-snapshot-2" })
    ]);
    const sent: OutboundMessage[] = [];
    let clockReads = 0;
    let synthesisCalls = 0;
    const summary = await runDueReminders({
      ...options(p, registry(async (message) => {
        sent.push(message);
        return {
          destination: message.destination,
          messageId: `accepted-${sent.length.toString()}`,
          providerId: "telegram"
        };
      }), () => {
        clockReads += 1;
        if (clockReads > 1) throw new Error("clock drifted after the tick snapshot");
        return new Date(NOW);
      }),
      activitySource: { lastActivityMs: () => Date.parse(NOW) },
      agentModel: "test-model",
      agentRuntime: {
        run: async () => {
          synthesisCalls += 1;
          return { response: { output: "Synthesized exact reminder." } };
        }
      }
    });

    expect(summary).toMatchObject({ delivered: 2, due: 2, errors: [] });
    expect(clockReads).toBe(1);
    expect(synthesisCalls).toBe(2);
    expect(sent).toHaveLength(2);
    const effects = await readOutboundEffects(p.effectFile);
    expect(effects.map(({ binding }) => binding.createdAt)).toEqual([NOW, NOW]);
    expect(effects.map(({ receipt }) => receipt?.receivedAt)).toEqual([NOW, NOW]);
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

  it("uses a distinct history effect for recurring occurrences across ticks", async () => {
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

    const secondTickAt = "2026-07-30T00:00:00.000Z";
    await runDueReminders(options(p, transport, () => new Date(secondTickAt)));
    expect(calls).toBe(2);
    const effects = await readOutboundEffects(p.effectFile);
    const occurrenceEffectIds = [
      reminderOccurrenceEffectId("rem-effect-1", DUE_AT),
      reminderOccurrenceEffectId("rem-effect-1", afterFirst.dueAt)
    ];
    const generations = [
      buildReminderTriggerEnvelope({ dueAt: DUE_AT, id: "rem-effect-1" }),
      buildReminderTriggerEnvelope(afterFirst)
    ];
    expect(generations.map(({ generation }) => generation)).toEqual([DUE_AT, afterFirst.dueAt]);
    expect(generations.map(({ dedupKey }) => dedupKey)).toEqual(occurrenceEffectIds);
    expect(effects.map(({ binding }) => binding.effectId)).toEqual(occurrenceEffectIds);
    const history = await readReminderHistory(p.historyFile);
    expect(history).toHaveLength(2);
    expect(history.map(({ effectId }) => effectId).sort()).toEqual([...occurrenceEffectIds].sort());
    expect(Object.fromEntries(history.map(({ effectId, firedAtIso }) => [effectId, firedAtIso]))).toEqual({
      [occurrenceEffectIds[0]!]: NOW,
      [occurrenceEffectIds[1]!]: secondTickAt
    });
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

  it.each([
    {
      label: "malformed JSON",
      originalBytes: "{\"reminders\":["
    },
    {
      label: "mixed valid and invalid entries",
      originalBytes: `${JSON.stringify({
        reminders: [reminder(), reminder({ dueAt: "not-a-date", id: "rem-invalid" })]
      }, null, 2)}\n`
    },
    {
      label: "duplicate IDs",
      originalBytes: `${JSON.stringify({
        reminders: [reminder(), reminder({ text: "Conflicting duplicate." })]
      }, null, 2)}\n`
    },
    {
      label: "non-canonical store shape",
      originalBytes: `${JSON.stringify({ reminders: [reminder()], version: 1 }, null, 2)}\n`
    }
  ])("rejects $label before any external effect or rewrite", async ({ originalBytes }) => {
    const p = paths();
    writeFileSync(p.remindersFile, originalBytes, { mode: 0o600 });
    let providerCalls = 0;

    await expect(runDueReminders(options(p, registry(async (message) => {
      providerCalls += 1;
      return { destination: message.destination, messageId: "must-not-send", providerId: "telegram" };
    })))).rejects.toThrow("reminder store cannot be read or validated");

    expect(providerCalls).toBe(0);
    expect(existsSync(p.effectFile)).toBe(false);
    expect(existsSync(p.historyFile)).toBe(false);
    expect(readFileSync(p.remindersFile, "utf8")).toBe(originalBytes);
  });

  it("keeps an absent reminder store as an empty no-op", async () => {
    const p = paths();
    let providerCalls = 0;

    const summary = await runDueReminders(options(p, registry(async (message) => {
      providerCalls += 1;
      return { destination: message.destination, messageId: "must-not-send", providerId: "telegram" };
    })));

    expect(summary).toEqual({ delivered: 0, due: 0, errors: [], fired: [] });
    expect(providerCalls).toBe(0);
    expect(existsSync(p.remindersFile)).toBe(false);
    expect(existsSync(p.effectFile)).toBe(false);
    expect(existsSync(p.historyFile)).toBe(false);
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
        childFixture,
        JSON.stringify(input)
      ]),
      execFileAsync(process.execPath, [
        "--import",
        "tsx",
        childFixture,
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
