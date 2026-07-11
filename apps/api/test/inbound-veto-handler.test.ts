import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLastProactiveDelivery, avoidedSourceKeys, readTrustLedger } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { handleInboundVetoReply, isVetoUtterance } from "../src/inbound-veto-handler.js";

function budgetDir(): string {
  return mkdtempSync(join(tmpdir(), "muse-veto-handler-"));
}

const NOW = new Date("2026-07-12T09:00:00.000Z");

describe("isVetoUtterance — whole-utterance only, no substring match", () => {
  it("matches the KO stop phrases (trim + trailing punctuation tolerant)", () => {
    expect(isVetoUtterance("그만")).toBe(true);
    expect(isVetoUtterance("그만해")).toBe(true);
    expect(isVetoUtterance("알림 그만")).toBe(true);
    expect(isVetoUtterance("알림 꺼")).toBe(true);
    expect(isVetoUtterance("이런 알림 그만")).toBe(true);
    expect(isVetoUtterance("이런 거 그만")).toBe(true);
    expect(isVetoUtterance("  그만해!  ")).toBe(true);
    expect(isVetoUtterance("그만.")).toBe(true);
  });

  it("matches the EN stop phrases (case-insensitive, trailing punctuation tolerant)", () => {
    expect(isVetoUtterance("stop")).toBe(true);
    expect(isVetoUtterance("Stop")).toBe(true);
    expect(isVetoUtterance("STOP THESE")).toBe(true);
    expect(isVetoUtterance("stop this")).toBe(true);
    expect(isVetoUtterance("mute this")).toBe(true);
    expect(isVetoUtterance("no more of these")).toBe(true);
    expect(isVetoUtterance("stop!")).toBe(true);
  });

  it("does NOT match a stop word embedded in a longer sentence", () => {
    expect(isVetoUtterance("그만두고 싶다는 생각이 들어")).toBe(false);
    expect(isVetoUtterance("should I stop working on this?")).toBe(false);
    expect(isVetoUtterance("please stop these emails from my boss")).toBe(false);
  });

  it("does NOT strip a trailing 'ㅋㅋ' as if it were punctuation", () => {
    expect(isVetoUtterance("그만ㅋㅋ")).toBe(false);
  });

  it("empty / whitespace-only text never matches", () => {
    expect(isVetoUtterance("")).toBe(false);
    expect(isVetoUtterance("   ")).toBe(false);
  });
});

describe("handleInboundVetoReply", () => {
  it("matches + recent delivery → records a vetoed ledger entry and confirms with an instance-level scope", async () => {
    const dir = budgetDir();
    const lastDeliveryFile = join(dir, "last-delivery.json");
    const trustLedgerFile = join(dir, "trust.json");
    await appendLastProactiveDelivery(lastDeliveryFile, {
      at: new Date(NOW.getTime() - 60_000),
      outcome: "delivered",
      sourceKey: "pattern-firing:pat-1",
      title: "your Tuesday journal habit"
    });

    const reply = await handleInboundVetoReply({ lastDeliveryFile, now: NOW, text: "그만", trustLedgerFile });
    expect(reply).toContain("your Tuesday journal habit");
    expect(reply).toContain("muse proactive keep pattern-firing:pat-1");

    const avoided = avoidedSourceKeys(await readTrustLedger(trustLedgerFile));
    expect(avoided.has("pattern-firing:pat-1")).toBe(true);
  });

  it("records the KIND-level key for a one-shot source (followup) and confirms with a kind-level scope", async () => {
    const dir = budgetDir();
    const lastDeliveryFile = join(dir, "last-delivery.json");
    const trustLedgerFile = join(dir, "trust.json");
    await appendLastProactiveDelivery(lastDeliveryFile, {
      at: new Date(NOW.getTime() - 60_000),
      outcome: "delivered",
      sourceKey: "followup:fu-1",
      title: "checking in on the interview"
    });

    const reply = await handleInboundVetoReply({ lastDeliveryFile, now: NOW, text: "stop", trustLedgerFile });
    expect(reply).toContain("이런 종류의 알림은 이제 안 보낼게");
    expect(reply).not.toContain("checking in on the interview");

    const avoided = avoidedSourceKeys(await readTrustLedger(trustLedgerFile));
    expect(avoided.has("followup")).toBe(true);
    expect(avoided.has("followup:fu-1")).toBe(false);
  });

  it("falls back to the sourceKey when the delivery has no title", async () => {
    const dir = budgetDir();
    const lastDeliveryFile = join(dir, "last-delivery.json");
    const trustLedgerFile = join(dir, "trust.json");
    await appendLastProactiveDelivery(lastDeliveryFile, {
      at: new Date(NOW.getTime() - 60_000),
      outcome: "delivered",
      sourceKey: "ambient-notice:standup-rule"
    });
    const reply = await handleInboundVetoReply({ lastDeliveryFile, now: NOW, text: "그만해", trustLedgerFile });
    expect(reply).toContain("ambient-notice:standup-rule");
  });

  it("a non-veto utterance falls through (undefined) without touching the ledger", async () => {
    const dir = budgetDir();
    const lastDeliveryFile = join(dir, "last-delivery.json");
    const trustLedgerFile = join(dir, "trust.json");
    await appendLastProactiveDelivery(lastDeliveryFile, {
      at: new Date(NOW.getTime() - 60_000), outcome: "delivered", sourceKey: "pattern-firing:pat-1"
    });
    const reply = await handleInboundVetoReply({ lastDeliveryFile, now: NOW, text: "what's my rent?", trustLedgerFile });
    expect(reply).toBeUndefined();
    expect(await readTrustLedger(trustLedgerFile)).toEqual([]);
  });

  it("no last-delivery on record → falls through, even for a matching veto phrase", async () => {
    const dir = budgetDir();
    const lastDeliveryFile = join(dir, "last-delivery.json");
    const trustLedgerFile = join(dir, "trust.json");
    const reply = await handleInboundVetoReply({ lastDeliveryFile, now: NOW, text: "stop", trustLedgerFile });
    expect(reply).toBeUndefined();
    expect(await readTrustLedger(trustLedgerFile)).toEqual([]);
  });

  it("a delivery OLDER than 24h does not veto — falls through", async () => {
    const dir = budgetDir();
    const lastDeliveryFile = join(dir, "last-delivery.json");
    const trustLedgerFile = join(dir, "trust.json");
    await appendLastProactiveDelivery(lastDeliveryFile, {
      at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000), // 25h ago
      outcome: "delivered",
      sourceKey: "pattern-firing:pat-1"
    });
    const reply = await handleInboundVetoReply({ lastDeliveryFile, now: NOW, text: "그만", trustLedgerFile });
    expect(reply).toBeUndefined();
    expect(await readTrustLedger(trustLedgerFile)).toEqual([]);
  });

  it("a delivery just inside the 24h window still vetoes", async () => {
    const dir = budgetDir();
    const lastDeliveryFile = join(dir, "last-delivery.json");
    const trustLedgerFile = join(dir, "trust.json");
    await appendLastProactiveDelivery(lastDeliveryFile, {
      at: new Date(NOW.getTime() - 23 * 60 * 60 * 1000 - 59 * 60 * 1000), // 23h59m ago
      outcome: "delivered",
      sourceKey: "pattern-firing:pat-1"
    });
    const reply = await handleInboundVetoReply({ lastDeliveryFile, now: NOW, text: "그만", trustLedgerFile });
    expect(reply).toBeDefined();
  });

  it("resolves the MOST RECENT delivery when several are on record", async () => {
    const dir = budgetDir();
    const lastDeliveryFile = join(dir, "last-delivery.json");
    const trustLedgerFile = join(dir, "trust.json");
    await appendLastProactiveDelivery(lastDeliveryFile, {
      at: new Date(NOW.getTime() - 120_000), outcome: "delivered", sourceKey: "pattern-firing:older"
    });
    await appendLastProactiveDelivery(lastDeliveryFile, {
      at: new Date(NOW.getTime() - 60_000), outcome: "delivered", sourceKey: "pattern-firing:newer"
    });
    await handleInboundVetoReply({ lastDeliveryFile, now: NOW, text: "그만", trustLedgerFile });
    const avoided = avoidedSourceKeys(await readTrustLedger(trustLedgerFile));
    expect(avoided.has("pattern-firing:newer")).toBe(true);
    expect(avoided.has("pattern-firing:older")).toBe(false);
  });

  it("ledger-append failure → falls through (undefined), never a false confirmation", async () => {
    const dir = budgetDir();
    const lastDeliveryFile = join(dir, "last-delivery.json");
    // A trust-ledger path whose PARENT is a regular file makes the atomic
    // writer's mkdir fail — recordOutcome cannot persist the veto.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x", "utf8");
    const trustLedgerFile = join(blocker, "trust.json");
    await appendLastProactiveDelivery(lastDeliveryFile, {
      at: new Date(NOW.getTime() - 60_000), outcome: "delivered", sourceKey: "pattern-firing:pat-1"
    });
    const reply = await handleInboundVetoReply({ lastDeliveryFile, now: NOW, text: "그만", trustLedgerFile });
    expect(reply).toBeUndefined();
  });
});
