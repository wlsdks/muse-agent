/**
 * Deterministic Korean question builder for "Muse가 확인하고 싶은 것" — one
 * uncertain inference the owner confirms/rejects. Turns a
 * `selectReconfirmableSlots` entry into a natural-language reconfirm
 * question — no LLM call, so the sentence is always exactly reproducible
 * from the slot's own fields. `category` mirrors the slot's `kind` (a
 * stable machine-readable tag for a UI badge); the Korean sentence itself
 * carries the human-readable detail (a preference's own `category`, a
 * schedule's `recurrence`, a veto's `scope`).
 *
 * Shared by every surface that shows this question: the Home web card
 * (`apps/api/src/user-model-reconfirm-card.ts` re-exports this module) and
 * the day-rhythm morning briefing's PUSHED reconfirm question
 * (`apps/cli/src/daemon-delivery-ticks.ts`'s `makeBriefingTick`).
 */

import type { UserModelSlot } from "./user-model-slots.js";

export interface ReconfirmCard {
  readonly slotId: string;
  readonly question: string;
  readonly category: string;
  readonly evidence?: string;
}

export interface ReconfirmableEntry {
  readonly slot: UserModelSlot;
  readonly effectiveConfidence: number;
}

export function buildReconfirmCard(entry: ReconfirmableEntry): ReconfirmCard {
  return {
    category: entry.slot.kind,
    evidence: buildEvidence(entry.effectiveConfidence),
    question: buildQuestion(entry.slot),
    slotId: entry.slot.id
  };
}

function buildEvidence(effectiveConfidence: number): string {
  const clamped = Math.max(0, Math.min(1, effectiveConfidence));
  const pct = Math.round(clamped * 100);
  return `추측의 신뢰도가 ${pct.toString()}%로 옅어졌어요.`;
}

// Slot values end in arbitrary text (Korean, English, numbers), so the
// sentence templates AVOID value-adjacent particles entirely (colon frame)
// instead of guessing 을/를 — a wrong particle reads worse than none.
// `scope` arrives as an English tag from the extractor prompt; map the
// known tags to Korean and DROP unknown ones rather than embedding raw
// ASCII mid-sentence.
const VETO_SCOPE_KO: Readonly<Record<string, string>> = {
  communication: "연락",
  food: "음식",
  meetings: "회의",
  scheduling: "일정",
  tooling: "도구"
};

function buildQuestion(slot: UserModelSlot): string {
  switch (slot.kind) {
    case "preference": {
      const label = slot.category ?? "취향";
      return `진안의 ${label} — 이렇게 추측하고 있어요: '${slot.value}'. 아직 맞나요?`;
    }
    case "schedule": {
      const recurrence = slot.recurrence ? ` (${slot.recurrence})` : "";
      return `진안에게 이런 일정 패턴이 있다고 추측하고 있어요: '${slot.value}'${recurrence}. 아직 맞나요?`;
    }
    case "veto": {
      const scopeKo = slot.scope ? VETO_SCOPE_KO[slot.scope.toLowerCase()] : undefined;
      const scope = scopeKo ? `${scopeKo} 쪽에서 ` : "";
      return `진안이 ${scope}이건 피하고 싶어 한다고 추측하고 있어요: '${slot.value}'. 아직 맞나요?`;
    }
    case "goal": {
      return `진안의 요즘 목표를 이렇게 추측하고 있어요: '${slot.value}'. 아직 맞나요?`;
    }
  }
}
