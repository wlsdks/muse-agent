import { describe, expect, it } from "vitest";

import { buildReconfirmCard } from "./user-model-reconfirm-card.js";

import type { UserModelSlot } from "@muse/memory";

const BASE_DATE = new Date("2026-06-01T00:00:00.000Z");

describe("buildReconfirmCard", () => {
  it("builds a preference question naming the category and value", () => {
    const slot: UserModelSlot = {
      category: "말투",
      confidence: 0.3,
      id: "pref-tone",
      kind: "preference",
      updatedAt: BASE_DATE,
      value: "간결한 답변"
    };
    const card = buildReconfirmCard({ effectiveConfidence: 0.12, slot });
    expect(card.slotId).toBe("pref-tone");
    expect(card.category).toBe("preference");
    expect(card.question).toBe("진안은 말투에서 '간결한 답변'을(를) 선호한다고 추측하고 있어요 — 맞나요?");
    expect(card.evidence).toBe("추측의 신뢰도가 12%로 옅어졌어요.");
  });

  it("falls back to a generic label when a preference has no category", () => {
    const slot: UserModelSlot = {
      confidence: 0.2,
      id: "pref-generic",
      kind: "preference",
      updatedAt: BASE_DATE,
      value: "아침형 작업"
    };
    const card = buildReconfirmCard({ effectiveConfidence: 0.2, slot });
    expect(card.question).toBe("진안은 취향에서 '아침형 작업'을(를) 선호한다고 추측하고 있어요 — 맞나요?");
  });

  it("builds a schedule question including the recurrence hint when present", () => {
    const slot: UserModelSlot = {
      confidence: 0.25,
      id: "sched-morning",
      kind: "schedule",
      recurrence: "daily 07:00 KST",
      updatedAt: BASE_DATE,
      value: "아침 7시 기상"
    };
    const card = buildReconfirmCard({ effectiveConfidence: 0.3, slot });
    expect(card.category).toBe("schedule");
    expect(card.question).toBe("진안은 '아침 7시 기상' (daily 07:00 KST)이라는 일정 패턴이 있다고 추측하고 있어요 — 맞나요?");
  });

  it("builds a schedule question without a recurrence decorator when absent", () => {
    const slot: UserModelSlot = {
      confidence: 0.25,
      id: "sched-no-rec",
      kind: "schedule",
      updatedAt: BASE_DATE,
      value: "주말 늦잠"
    };
    const card = buildReconfirmCard({ effectiveConfidence: 0.3, slot });
    expect(card.question).toBe("진안은 '주말 늦잠'이라는 일정 패턴이 있다고 추측하고 있어요 — 맞나요?");
  });

  it("builds a veto question including a scope when present", () => {
    const slot: UserModelSlot = {
      confidence: 0.15,
      id: "veto-eggs",
      kind: "veto",
      scope: "food",
      updatedAt: BASE_DATE,
      value: "계란"
    };
    const card = buildReconfirmCard({ effectiveConfidence: 0.1, slot });
    expect(card.category).toBe("veto");
    expect(card.question).toBe("진안은 food 관련해서 '계란'을(를) 피하고 싶어 한다고 추측하고 있어요 — 맞나요?");
  });

  it("builds a veto question without a scope prefix when absent", () => {
    const slot: UserModelSlot = {
      confidence: 0.15,
      id: "veto-generic",
      kind: "veto",
      updatedAt: BASE_DATE,
      value: "이른 아침 회의"
    };
    const card = buildReconfirmCard({ effectiveConfidence: 0.1, slot });
    expect(card.question).toBe("진안은 '이른 아침 회의'을(를) 피하고 싶어 한다고 추측하고 있어요 — 맞나요?");
  });

  it("builds a goal question", () => {
    const slot: UserModelSlot = {
      confidence: 0.3,
      id: "goal-ship",
      kind: "goal",
      updatedAt: BASE_DATE,
      value: "Muse 1.0 출시"
    };
    const card = buildReconfirmCard({ effectiveConfidence: 0.25, slot });
    expect(card.category).toBe("goal");
    expect(card.question).toBe("진안은 'Muse 1.0 출시'을(를) 목표로 하고 있다고 추측하고 있어요 — 맞나요?");
  });

  it("clamps + rounds the evidence percentage deterministically", () => {
    const slot: UserModelSlot = {
      confidence: 0.5,
      id: "pref-clamp",
      kind: "preference",
      updatedAt: BASE_DATE,
      value: "x"
    };
    expect(buildReconfirmCard({ effectiveConfidence: -0.4, slot }).evidence).toBe("추측의 신뢰도가 0%로 옅어졌어요.");
    expect(buildReconfirmCard({ effectiveConfidence: 1.4, slot }).evidence).toBe("추측의 신뢰도가 100%로 옅어졌어요.");
    expect(buildReconfirmCard({ effectiveConfidence: 0.125, slot }).evidence).toBe("추측의 신뢰도가 13%로 옅어졌어요.");
  });
});
