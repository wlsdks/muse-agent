/**
 * Humanizes the auto-extractor's snake_case fact keys for display (the store
 * itself is never rewritten — display-only, deterministic). Known keys get a
 * proper label per language; unknown keys fall back to prettified snake_case
 * rather than leaking raw identifiers into the UI.
 */

import type { Lang } from "../i18n/index.js";

const KNOWN: Readonly<Record<string, { readonly en: string; readonly ko: string }>> = {
  cat_name: { en: "Cat's name", ko: "고양이 이름" },
  dog_name: { en: "Dog's name", ko: "강아지 이름" },
  home_city: { en: "Home city", ko: "사는 곳" },
  pet_cat_name: { en: "Cat's name", ko: "고양이 이름" },
  pet_dog_name: { en: "Dog's name", ko: "강아지 이름" },
  pet_names: { en: "Pets", ko: "반려동물" },
  role: { en: "Role", ko: "직업" },
  user_name: { en: "Name", ko: "이름" }
};

export function factLabel(key: string, lang: Lang): string {
  const known = KNOWN[key];
  if (known) {
    return lang === "ko" ? known.ko : known.en;
  }
  const pretty = key.replace(/_+/g, " ").trim();
  return pretty.length > 0 ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : key;
}

export interface FactGroup {
  readonly value: string;
  /** Original store keys sharing this value, first-seen order. */
  readonly keys: readonly string[];
}

/** Groups facts that carry the SAME value (the extractor historically wrote
 * one entity under several keys — 보리 as dog_name, cat_name, pet_dog_name…)
 * into one display row, keeping every key visible so a wrong binding stays
 * correctable instead of hidden. Display-only: the store is untouched. */
export function groupFactsByValue(facts: Readonly<Record<string, string>>): readonly FactGroup[] {
  const order: string[] = [];
  const byValue = new Map<string, string[]>();
  for (const [key, value] of Object.entries(facts)) {
    const existing = byValue.get(value);
    if (existing) {
      existing.push(key);
    } else {
      byValue.set(value, [key]);
      order.push(value);
    }
  }
  return order.map((value) => ({ keys: byValue.get(value) ?? [], value }));
}
