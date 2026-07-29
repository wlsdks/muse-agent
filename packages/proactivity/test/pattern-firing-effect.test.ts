import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  aggregateActivitySignals,
  selectFireablePatterns,
  type PatternMatch
} from "@muse/memory";
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
  appendInterruptionDelivery,
  readPatternsFired,
  recordOutcome
} from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  patternNaturalSlotEffectId,
  runDuePatternNotices
} from "../src/pattern-firing-loop.js";

const NOW = new Date(2026, 4, 12, 21, 30, 0);
const execFileAsync = promisify(execFile);
const childFixture = new URL("./fixtures/pattern-firing-effect-child.ts", import.meta.url);

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "muse-pattern-effect-"));
  return {
    callsFile: join(dir, "provider-calls.txt"),
    dir,
    effectFile: join(dir, "outbound-effects.json"),
    notesDir: join(dir, "notes"),
    patternsFiredFile: join(dir, "patterns-fired.json")
  };
}

async function seedPattern(notesDir: string): Promise<void> {
  await mkdir(join(notesDir, "journal"), { recursive: true });
  for (let k = 1; k <= 5; k += 1) {
    const file = join(notesDir, "journal", `entry-${k.toString()}.md`);
    await writeFile(file, `journal ${k.toString()}`, "utf8");
    const when = new Date(NOW.getTime() - k * 7 * 86_400_000);
    await utimes(file, when, when);
  }
}

async function discoverMatch(notesDir: string): Promise<PatternMatch> {
  const signals = await aggregateActivitySignals({
    notesDir,
    now: () => NOW.getTime()
  });
  const match = selectFireablePatterns(NOW, signals, [], {})[0];
  if (!match) throw new Error("fixture did not produce a fireable pattern");
  return match;
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

function options(
  p: ReturnType<typeof paths>,
  messaging: MessagingProviderRegistry
) {
  return {
    destination: "@owner",
    effectFile: p.effectFile,
    now: () => NOW,
    patternsFiredFile: p.patternsFiredFile,
    providerId: "telegram",
    registry: messaging,
    signals: { notesDir: p.notesDir }
  } as const;
}

describe("pattern natural-slot durable effects", () => {
  it("pins local day/hour-band, ISO-week rollover, year boundary, and repeated-DST identities", () => {
    const timeOfDay: PatternMatch = {
      bucket: {
        distinctDays: 4,
        hourBand: "0-3",
        matches: 4,
        pathFamily: "journal",
        weekday: "Sun"
      },
      category: "time-of-day-action",
      confidence: 1,
      id: "tod-pattern",
      relatedPaths: [],
      suggestion: "Open journal"
    };
    const weekly: PatternMatch = {
      bucket: {
        distinctWeeks: 4,
        matches: 4,
        titleKey: "weekly review",
        titleTemplate: "Weekly review",
        weekday: "Mon"
      },
      category: "weekly-task",
      confidence: 1,
      id: "weekly-pattern",
      missingThisWeek: true,
      relatedTitles: ["Weekly review"],
      suggestion: "Create weekly review"
    };
    const dayA = patternNaturalSlotEffectId(timeOfDay, new Date(2026, 4, 12, 1, 15));
    const dayASameBand = patternNaturalSlotEffectId(timeOfDay, new Date(2026, 4, 12, 2, 45));
    const dayB = patternNaturalSlotEffectId(timeOfDay, new Date(2026, 4, 13, 1, 15));
    expect(dayA).toMatch(/^pattern:[0-9a-f]{64}$/u);
    expect(dayASameBand).toBe(dayA);
    expect(dayB).not.toBe(dayA);

    expect(patternNaturalSlotEffectId(weekly, new Date(2026, 11, 28)))
      .toBe(patternNaturalSlotEffectId(weekly, new Date(2027, 0, 3)));
    expect(patternNaturalSlotEffectId(weekly, new Date(2027, 0, 4)))
      .not.toBe(patternNaturalSlotEffectId(weekly, new Date(2027, 0, 3)));

    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const firstOneThirty = new Date("2026-11-01T01:30:00-04:00");
      const repeatedOneThirty = new Date("2026-11-01T01:30:00-05:00");
      expect(patternNaturalSlotEffectId(timeOfDay, firstOneThirty))
        .toBe(patternNaturalSlotEffectId(timeOfDay, repeatedOneThirty));
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it("lets the first API fallback binding win over later CLI composition and never replays the broker", async () => {
    const p = paths();
    await seedPattern(p.notesDir);
    const match = await discoverMatch(p.notesDir);
    const sent: OutboundMessage[] = [];
    const published: string[] = [];
    const first = await runDuePatternNotices({
      ...options(p, registry(async (message) => {
        sent.push(message);
        return { destination: message.destination, messageId: "accepted-fallback", providerId: "telegram" };
      })),
      agentInitiatedNoticeBroker: {
        publish: (_userId, notice) => { published.push(notice.text); }
      },
      agentInitiatedNoticeUserId: "owner",
      select: { cooldownMs: 0 }
    });
    let composeCalls = 0;
    const replay = await runDuePatternNotices({
      ...options(p, new MessagingProviderRegistry([])),
      agentInitiatedNoticeBroker: {
        publish: (_userId, notice) => { published.push(notice.text); }
      },
      agentInitiatedNoticeUserId: "owner",
      composeSuggestion: async () => {
        composeCalls += 1;
        return "CLI-composed text must not replace the first binding";
      },
      select: { cooldownMs: 0 }
    });
    const effectId = patternNaturalSlotEffectId(match, NOW);

    expect(first.delivered).toBe(1);
    expect(replay.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ idempotencyKey: effectId, text: match.suggestion });
    expect(composeCalls).toBe(0);
    expect(published).toEqual([match.suggestion]);
    expect(await readOutboundEffect(p.effectFile, effectId)).toMatchObject({ state: "accepted" });
    expect((await readPatternsFired(p.patternsFiredFile)).map((entry) => entry.firedAtMs))
      .toEqual([NOW.getTime(), NOW.getTime()]);
  });

  it("seals provider failure and crash-left prepared as unknown without cooldown or replay", async () => {
    const p = paths();
    await seedPattern(p.notesDir);
    let providerCalls = 0;
    let composeCalls = 0;
    const active = {
      ...options(p, registry(async () => {
        providerCalls += 1;
        throw new Error("ambiguous provider timeout");
      })),
      composeSuggestion: async () => {
        composeCalls += 1;
        return "Composed once";
      }
    };
    const first = await runDuePatternNotices(active);
    const replay = await runDuePatternNotices({
      ...active,
      registry: new MessagingProviderRegistry([])
    });
    expect(first.errors.join("\n")).toContain("delivery is unknown");
    expect(replay.errors.join("\n")).toContain("reconcile manually");
    expect(providerCalls).toBe(1);
    expect(composeCalls).toBe(1);
    expect(await readPatternsFired(p.patternsFiredFile)).toEqual([]);

    const prepared = paths();
    await seedPattern(prepared.notesDir);
    const preparedMatch = await discoverMatch(prepared.notesDir);
    const effectId = patternNaturalSlotEffectId(preparedMatch, NOW);
    await prepareOutboundEffect(prepared.effectFile, {
      createdAt: NOW.toISOString(),
      destination: "@owner",
      effectId,
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "@owner",
        providerId: "telegram",
        text: "First binding payload"
      }),
      providerId: "telegram"
    });
    const preparedResult = await runDuePatternNotices(options(
      prepared,
      new MessagingProviderRegistry([])
    ));
    expect(preparedResult.errors.join("\n")).toContain("delivery is unknown");
    expect(await readPatternsFired(prepared.patternsFiredFile)).toEqual([]);
  });

  it("repairs accepted cooldown from the receipt with no provider, composition, send, or broker", async () => {
    const p = paths();
    await seedPattern(p.notesDir);
    const match = await discoverMatch(p.notesDir);
    let providerCalls = 0;
    const active = options(p, registry(async (message) => {
      providerCalls += 1;
      rmSync(p.patternsFiredFile, { force: true });
      mkdirSync(p.patternsFiredFile);
      return { destination: message.destination, messageId: "accepted-before-cooldown", providerId: "telegram" };
    }));
    const incomplete = await runDuePatternNotices(active);
    expect(incomplete.delivered).toBe(0);
    rmSync(p.patternsFiredFile, { force: true, recursive: true });

    let composeCalls = 0;
    let brokerCalls = 0;
    const repaired = await runDuePatternNotices({
      ...active,
      agentInitiatedNoticeBroker: { publish: () => { brokerCalls += 1; } },
      agentInitiatedNoticeUserId: "owner",
      composeSuggestion: async () => {
        composeCalls += 1;
        return "must not compose";
      },
      registry: new MessagingProviderRegistry([])
    });
    expect(repaired.delivered).toBe(1);
    expect(providerCalls).toBe(1);
    expect(composeCalls).toBe(0);
    expect(brokerCalls).toBe(0);
    expect(await readPatternsFired(p.patternsFiredFile)).toEqual([
      { firedAtMs: NOW.getTime(), patternId: match.id }
    ]);
  });

  it("seals reconciled-not-delivered for the current slot while the next natural slot has a fresh id", async () => {
    const p = paths();
    await seedPattern(p.notesDir);
    const match = await discoverMatch(p.notesDir);
    let providerCalls = 0;
    await runDuePatternNotices(options(p, registry(async () => {
      providerCalls += 1;
      throw new Error("unknown acceptance");
    })));
    const effectId = patternNaturalSlotEffectId(match, NOW);
    await reconcileOutboundEffect(p.effectFile, {
      actor: "owner",
      decision: "not-delivered",
      effectId,
      reason: "provider has no matching message",
      recordedAt: NOW.toISOString()
    });
    const sealed = await runDuePatternNotices(options(p, new MessagingProviderRegistry([])));

    expect(sealed.delivered).toBe(0);
    expect(sealed.errors).toEqual([]);
    expect(sealed.fired).toHaveLength(1);
    expect(providerCalls).toBe(1);
    expect(await readPatternsFired(p.patternsFiredFile)).toEqual([
      { firedAtMs: NOW.getTime(), patternId: match.id }
    ]);
    expect(patternNaturalSlotEffectId(match, new Date(NOW.getTime() + 7 * 86_400_000)))
      .not.toBe(effectId);
  });

  it("creates no effect for digest or veto while preserving cooldown and broker behavior", async () => {
    const digest = paths();
    await seedPattern(digest.notesDir);
    await appendInterruptionDelivery(join(digest.dir, "interruption.json"), {
      at: NOW,
      source: "pattern-firing"
    });
    let digestBrokerCalls = 0;
    const digested = await runDuePatternNotices({
      ...options(digest, new MessagingProviderRegistry([])),
      agentInitiatedNoticeBroker: { publish: () => { digestBrokerCalls += 1; } },
      agentInitiatedNoticeUserId: "owner",
      interruptionBudget: {
        dailyCap: 5,
        digestFile: join(digest.dir, "digest.json"),
        hourlyCap: 1,
        ledgerFile: join(digest.dir, "interruption.json")
      }
    });
    expect(digested.delivered).toBe(0);
    expect(digestBrokerCalls).toBe(1);
    expect(existsSync(digest.effectFile)).toBe(false);
    expect(await readPatternsFired(digest.patternsFiredFile)).toHaveLength(1);

    const veto = paths();
    await seedPattern(veto.notesDir);
    const match = await discoverMatch(veto.notesDir);
    const trustFile = join(veto.dir, "trust.json");
    await recordOutcome(trustFile, `pattern-firing:${match.id}`, "vetoed", NOW.getTime());
    let vetoBrokerCalls = 0;
    const skipped = await runDuePatternNotices({
      ...options(veto, new MessagingProviderRegistry([])),
      agentInitiatedNoticeBroker: { publish: () => { vetoBrokerCalls += 1; } },
      agentInitiatedNoticeUserId: "owner",
      interruptionBudget: {
        dailyCap: 5,
        digestFile: join(veto.dir, "digest.json"),
        hourlyCap: 5,
        ledgerFile: join(veto.dir, "interruption.json"),
        trustLedgerFile: trustFile
      }
    });
    expect(skipped.delivered).toBe(0);
    expect(vetoBrokerCalls).toBe(0);
    expect(existsSync(veto.effectFile)).toBe(false);
    expect(await readPatternsFired(veto.patternsFiredFile)).toHaveLength(1);
  });

  it("suppresses a repeated pattern across a process burst, restart, and backward clock skew", async () => {
    const p = paths();
    await seedPattern(p.notesDir);
    const input = {
      callsFile: p.callsFile,
      effectFile: p.effectFile,
      notesDir: p.notesDir,
      nowIso: NOW.toISOString(),
      patternsFiredFile: p.patternsFiredFile
    };
    const burst = await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", childFixture.pathname, JSON.stringify(input)]),
      execFileAsync(process.execPath, ["--import", "tsx", childFixture.pathname, JSON.stringify(input)])
    ]);
    const restart = await execFileAsync(
      process.execPath,
      ["--import", "tsx", childFixture.pathname, JSON.stringify(input)]
    );
    const backwardClock = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        childFixture.pathname,
        JSON.stringify({
          ...input,
          nowIso: new Date(NOW.getTime() - 60_000).toISOString()
        })
      ]
    );
    const summaries = [...burst, restart, backwardClock].map(({ stdout }) =>
      JSON.parse(stdout.trim()) as { readonly delivered: number }
    );

    const providerCalls = existsSync(p.callsFile)
      ? readFileSync(p.callsFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    expect(summaries.map((summary) => summary.delivered).sort()).toEqual([0, 0, 0, 1]);
    expect(providerCalls).toHaveLength(1);
    expect(await readOutboundEffects(p.effectFile)).toHaveLength(1);
    expect(await readPatternsFired(p.patternsFiredFile)).toHaveLength(1);
  }, 20_000);
});
