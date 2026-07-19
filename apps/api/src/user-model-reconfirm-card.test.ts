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
    expect(card.question).toBe("진안의 말투 — 이렇게 추측하고 있어요: '간결한 답변'. 아직 맞나요?");
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
    expect(card.question).toBe("진안의 취향 — 이렇게 추측하고 있어요: '아침형 작업'. 아직 맞나요?");
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
    expect(card.question).toBe("진안에게 이런 일정 패턴이 있다고 추측하고 있어요: '아침 7시 기상' (daily 07:00 KST). 아직 맞나요?");
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
    expect(card.question).toBe("진안에게 이런 일정 패턴이 있다고 추측하고 있어요: '주말 늦잠'. 아직 맞나요?");
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
    expect(card.question).toBe("진안이 음식 쪽에서 이건 피하고 싶어 한다고 추측하고 있어요: '계란'. 아직 맞나요?");
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
    expect(card.question).toBe("진안이 이건 피하고 싶어 한다고 추측하고 있어요: '이른 아침 회의'. 아직 맞나요?");
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
    expect(card.question).toBe("진안의 요즘 목표를 이렇게 추측하고 있어요: 'Muse 1.0 출시'. 아직 맞나요?");
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
