/**
 * Deterministic Korean question builder for the Home "Muse가 확인하고 싶은
 * 것" card. Turns one `selectReconfirmableSlots` entry (`@muse/memory`) into
 * a natural-language reconfirm question — no LLM call, so the sentence is
 * always exactly reproducible from the slot's own fields. `category` mirrors
 * the slot's `kind` (a stable machine-readable tag for the web badge); the
 * Korean sentence itself carries the human-readable detail (a preference's
 * own `category`, a schedule's `recurrence`, a veto's `scope`).
 */

import type { UserModelSlot } from "@muse/memory";

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

function buildQuestion(slot: UserModelSlot): string {
  switch (slot.kind) {
    case "preference": {
      const label = slot.category ?? "취향";
      return `진안은 ${label}에서 '${slot.value}'을(를) 선호한다고 추측하고 있어요 — 맞나요?`;
    }
    case "schedule": {
      const recurrence = slot.recurrence ? ` (${slot.recurrence})` : "";
      return `진안은 '${slot.value}'${recurrence}이라는 일정 패턴이 있다고 추측하고 있어요 — 맞나요?`;
    }
    case "veto": {
      const scope = slot.scope ? `${slot.scope} 관련해서 ` : "";
      return `진안은 ${scope}'${slot.value}'을(를) 피하고 싶어 한다고 추측하고 있어요 — 맞나요?`;
    }
    case "goal": {
      return `진안은 '${slot.value}'을(를) 목표로 하고 있다고 추측하고 있어요 — 맞나요?`;
    }
  }
}
