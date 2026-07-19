import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { markReconfirmCardDelivered, readReconfirmCardAnsweredDate } from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  classifyReconfirmReplyUtterance,
  handleInboundReconfirmReply
} from "../src/inbound-reconfirm-handler.js";

import type { UserModel, UserModelSlot } from "@muse/memory";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "muse-reconfirm-handler-"));
}

const NOW = new Date("2026-07-16T09:00:00.000Z");

describe("classifyReconfirmReplyUtterance — whole-utterance only, no substring match", () => {
  it("matches the confirm closed set", () => {
    expect(classifyReconfirmReplyUtterance("맞아")).toBe("confirm");
    expect(classifyReconfirmReplyUtterance("맞아요")).toBe("confirm");
    expect(classifyReconfirmReplyUtterance("응 맞아")).toBe("confirm");
  });

  it("matches the reject closed set", () => {
    expect(classifyReconfirmReplyUtterance("아니야")).toBe("reject");
    expect(classifyReconfirmReplyUtterance("아니에요")).toBe("reject");
    expect(classifyReconfirmReplyUtterance("틀려")).toBe("reject");
  });

  it("trims + tolerates trailing punctuation/whitespace", () => {
    expect(classifyReconfirmReplyUtterance("  맞아!  ")).toBe("confirm");
    expect(classifyReconfirmReplyUtterance("아니야.")).toBe("reject");
    expect(classifyReconfirmReplyUtterance("아니야~")).toBe("reject");
  });

  it("does NOT match a multi-clause sentence that merely CONTAINS the phrase", () => {
    expect(classifyReconfirmReplyUtterance("아니야 그거 말고 다른 얘기")).toBeUndefined();
    expect(classifyReconfirmReplyUtterance("맞아 근데 다른 질문 있어")).toBeUndefined();
    expect(classifyReconfirmReplyUtterance("그거 아니야?")).toBeUndefined();
  });

  it("does NOT strip a trailing 'ㅋㅋ' as if it were punctuation", () => {
    expect(classifyReconfirmReplyUtterance("아니야ㅋㅋ")).toBeUndefined();
  });

  it("empty / whitespace-only / unrelated text never matches", () => {
    expect(classifyReconfirmReplyUtterance("")).toBeUndefined();
    expect(classifyReconfirmReplyUtterance("   ")).toBeUndefined();
    expect(classifyReconfirmReplyUtterance("오늘 날씨 어때?")).toBeUndefined();
  });
});

function slotModel(slot: UserModelSlot): UserModel {
  return {
    goals: slot.kind === "goal" ? [slot] : [],
    preferences: slot.kind === "preference" ? [slot] : [],
    schedule: slot.kind === "schedule" ? [slot] : [],
    vetoes: slot.kind === "veto" ? [slot] : []
  };
}

function fakeStore(slot: UserModelSlot | undefined) {
  const calls = { removes: [] as string[], upserts: [] as UserModelSlot[] };
  return {
    calls,
    store: {
      findByUserId: async () => (slot ? { userModel: slotModel(slot) } : { userModel: undefined }),
      removeUserModelSlot: async (_userId: string, id: string) => {
        calls.removes.push(id);
        return {};
      },
      upsertUserModelSlot: async (_userId: string, upserted: UserModelSlot) => {
        calls.upserts.push(upserted);
        return {};
      }
    }
  };
}

describe("handleInboundReconfirmReply", () => {
  it("confirm applies the SAME mutation the web card uses (confidence cleared, updatedAt bumped) and acks", async () => {
    const d = dir();
    const deliveryFile = join(d, "delivery.json");
    const answeredFile = join(d, "answered.json");
    await markReconfirmCardDelivered(deliveryFile, "pref-tone", new Date(NOW.getTime() - 60_000));
    const { store, calls } = fakeStore({
      category: "말투", confidence: 0.2, id: "pref-tone", kind: "preference", updatedAt: new Date("2026-06-01T00:00:00.000Z"), value: "간결한 답변"
    });

    const reply = await handleInboundReconfirmReply({
      answeredFile, defaultUserId: "stark", deliveryFile, now: NOW, text: "맞아", userMemoryStore: store
    });

    expect(reply).toBe("고마워요 — 반영했어요.");
    expect(calls.upserts).toHaveLength(1);
    expect(calls.upserts[0]).toMatchObject({ category: "말투", id: "pref-tone", kind: "preference", updatedAt: NOW, value: "간결한 답변" });
    expect("confidence" in calls.upserts[0]!).toBe(false);
    expect(calls.removes).toHaveLength(0);
  });

  it("reject removes the slot (same mutation as the web card's reject) and acks", async () => {
    const d = dir();
    const deliveryFile = join(d, "delivery.json");
    const answeredFile = join(d, "answered.json");
    await markReconfirmCardDelivered(deliveryFile, "veto-eggs", new Date(NOW.getTime() - 60_000));
    const { store, calls } = fakeStore({ confidence: 0.1, id: "veto-eggs", kind: "veto", scope: "food", updatedAt: new Date("2026-06-01T00:00:00.000Z"), value: "계란" });

    const reply = await handleInboundReconfirmReply({
      answeredFile, defaultUserId: "stark", deliveryFile, now: NOW, text: "아니야", userMemoryStore: store
    });

    expect(reply).toBe("알려줘서 고마워요 — 다시 추측하지 않을게요.");
    expect(calls.removes).toEqual(["veto-eggs"]);
    expect(calls.upserts).toHaveLength(0);
  });

  it("both confirm and reject mark the per-day sidecar (SHARED with the Home card)", async () => {
    const d = dir();
    const deliveryFile = join(d, "delivery.json");
    const answeredFile = join(d, "answered.json");
    await markReconfirmCardDelivered(deliveryFile, "pref-1", new Date(NOW.getTime() - 60_000));
    const { store } = fakeStore({ confidence: 0.2, id: "pref-1", kind: "preference", updatedAt: new Date("2026-06-01T00:00:00.000Z"), value: "x" });
    await handleInboundReconfirmReply({ answeredFile, defaultUserId: "stark", deliveryFile, now: NOW, text: "맞아", userMemoryStore: store });
    expect(await readReconfirmCardAnsweredDate(answeredFile)).toBe("2026-07-16");
  });

  it("a non-reconfirm utterance falls through (undefined) — no store mutation, no sidecar write", async () => {
    const d = dir();
    const deliveryFile = join(d, "delivery.json");
    const answeredFile = join(d, "answered.json");
    await markReconfirmCardDelivered(deliveryFile, "pref-1", new Date(NOW.getTime() - 60_000));
    const { store, calls } = fakeStore({ confidence: 0.2, id: "pref-1", kind: "preference", updatedAt: new Date("2026-06-01T00:00:00.000Z"), value: "x" });

    const reply = await handleInboundReconfirmReply({
      answeredFile, defaultUserId: "stark", deliveryFile, now: NOW, text: "오늘 날씨 어때?", userMemoryStore: store
    });

    expect(reply).toBeUndefined();
    expect(calls.upserts).toHaveLength(0);
    expect(calls.removes).toHaveLength(0);
    expect(await readReconfirmCardAnsweredDate(answeredFile)).toBeUndefined();
  });

  it("no recent delivery on record → falls through, even for a matching reconfirm phrase (never a false ack)", async () => {
    const d = dir();
    const deliveryFile = join(d, "delivery.json");
    const answeredFile = join(d, "answered.json");
    const { store, calls } = fakeStore({ confidence: 0.2, id: "pref-1", kind: "preference", updatedAt: new Date("2026-06-01T00:00:00.000Z"), value: "x" });

    const reply = await handleInboundReconfirmReply({
      answeredFile, defaultUserId: "stark", deliveryFile, now: NOW, text: "아니야", userMemoryStore: store
    });

    expect(reply).toBeUndefined();
    expect(calls.upserts).toHaveLength(0);
    expect(calls.removes).toHaveLength(0);
  });

  it("a delivery OLDER than 24h falls through — 아니야 is NOT swallowed for a stale question", async () => {
    const d = dir();
    const deliveryFile = join(d, "delivery.json");
    const answeredFile = join(d, "answered.json");
    await markReconfirmCardDelivered(deliveryFile, "pref-1", new Date(NOW.getTime() - 25 * 60 * 60 * 1000));
    const { store, calls } = fakeStore({ confidence: 0.2, id: "pref-1", kind: "preference", updatedAt: new Date("2026-06-01T00:00:00.000Z"), value: "x" });

    const reply = await handleInboundReconfirmReply({
      answeredFile, defaultUserId: "stark", deliveryFile, now: NOW, text: "아니야", userMemoryStore: store
    });

    expect(reply).toBeUndefined();
    expect(calls.removes).toHaveLength(0);
  });

  it("the day already answered (e.g. via the Home web card) → falls through, no double-mutation", async () => {
    const d = dir();
    const deliveryFile = join(d, "delivery.json");
    const answeredFile = join(d, "answered.json");
    await markReconfirmCardDelivered(deliveryFile, "pref-1", new Date(NOW.getTime() - 60_000));
    const { markReconfirmCardAnswered } = await import("@muse/stores");
    await markReconfirmCardAnswered(answeredFile, NOW);
    const { store, calls } = fakeStore({ confidence: 0.2, id: "pref-1", kind: "preference", updatedAt: new Date("2026-06-01T00:00:00.000Z"), value: "x" });

    const reply = await handleInboundReconfirmReply({
      answeredFile, defaultUserId: "stark", deliveryFile, now: NOW, text: "맞아", userMemoryStore: store
    });

    expect(reply).toBeUndefined();
    expect(calls.upserts).toHaveLength(0);
  });

  it("the delivered slot no longer exists (already answered elsewhere then removed, or unrelated) → falls through", async () => {
    const d = dir();
    const deliveryFile = join(d, "delivery.json");
    const answeredFile = join(d, "answered.json");
    await markReconfirmCardDelivered(deliveryFile, "ghost-slot", new Date(NOW.getTime() - 60_000));
    const { store, calls } = fakeStore(undefined);

    const reply = await handleInboundReconfirmReply({
      answeredFile, defaultUserId: "stark", deliveryFile, now: NOW, text: "맞아", userMemoryStore: store
    });

    expect(reply).toBeUndefined();
    expect(calls.upserts).toHaveLength(0);
    expect(calls.removes).toHaveLength(0);
  });

  it("no userMemoryStore configured → falls through", async () => {
    const d = dir();
    const deliveryFile = join(d, "delivery.json");
    const answeredFile = join(d, "answered.json");
    await markReconfirmCardDelivered(deliveryFile, "pref-1", new Date(NOW.getTime() - 60_000));

    const reply = await handleInboundReconfirmReply({
      answeredFile, defaultUserId: "stark", deliveryFile, now: NOW, text: "맞아", userMemoryStore: undefined
    });

    expect(reply).toBeUndefined();
  });

  it("mutation-write failure → falls through (undefined), never a false ack", async () => {
    const d = dir();
    const deliveryFile = join(d, "delivery.json");
    // The answered sidecar's PARENT is a regular file, so markReconfirmCardAnswered's
    // atomic writer's mkdir fails — the mutation "succeeds" but the mark-answered
    // step throws, and the whole handler must still fall through with no ack.
    const blocker = join(d, "blocker");
    writeFileSync(blocker, "x", "utf8");
    const answeredFile = join(blocker, "answered.json");
    await markReconfirmCardDelivered(deliveryFile, "pref-1", new Date(NOW.getTime() - 60_000));
    const { store, calls } = fakeStore({ confidence: 0.2, id: "pref-1", kind: "preference", updatedAt: new Date("2026-06-01T00:00:00.000Z"), value: "x" });

    const reply = await handleInboundReconfirmReply({
      answeredFile, defaultUserId: "stark", deliveryFile, now: NOW, text: "맞아", userMemoryStore: store
    });

    expect(reply).toBeUndefined();
    // The user-model mutation itself DID run (it's the mark-answered write
    // that failed) — the handler still refuses to ack since it can't
    // guarantee the day's sidecar was recorded.
    expect(calls.upserts).toHaveLength(1);
  });

  it("a delivery just inside the 24h window still answers", async () => {
    const d = dir();
    const deliveryFile = join(d, "delivery.json");
    const answeredFile = join(d, "answered.json");
    await markReconfirmCardDelivered(deliveryFile, "pref-1", new Date(NOW.getTime() - 23 * 60 * 60 * 1000 - 59 * 60 * 1000));
    const { store } = fakeStore({ confidence: 0.2, id: "pref-1", kind: "preference", updatedAt: new Date("2026-06-01T00:00:00.000Z"), value: "x" });

    const reply = await handleInboundReconfirmReply({
      answeredFile, defaultUserId: "stark", deliveryFile, now: NOW, text: "맞아", userMemoryStore: store
    });

    expect(reply).toBeDefined();
  });
});
