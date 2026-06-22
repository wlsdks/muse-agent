/**
 * `muse ask`'s pure percentage fast-path — the everyday-money sibling of the
 * arithmetic / date / unit fast-paths. The local 8B is unreliable at the
 * percentage word-problems people actually ask (tips, discounts, tax, raises),
 * and the symbolic arithmetic fast-path can't reach them because they carry
 * words ("of", "off", "tip") and currency symbols. So a query that is nothing
 * but such a computation is answered EXACTLY here. Precision-first: only the
 * recognised shapes fire, so a non-percentage question falls through to recall.
 */

type PercentageKind = "of" | "off" | "increase" | "decrease" | "tip";

export interface PercentageQuery {
  readonly kind: PercentageKind;
  readonly percent: number;
  readonly base: number;
  /** Currency prefix to echo in the answer ("$" when the base was written "$80", else ""). */
  readonly currency: string;
}

const NUM = "\\$?\\s*(\\d[\\d,]*(?:\\.\\d+)?)";
const PCT = "(\\d+(?:\\.\\d+)?)\\s*(?:%|percent)";

// Each pattern is anchored so only a query that is ENTIRELY the computation
// fires (an optional "what's/what is/calculate" lead allowed). Order matters:
// the keyworded shapes (off/tip/increase/decrease) are tried before bare "of".
const LEAD = "^(?:what(?:'s|s| is)?|calculate|compute)?\\s*";
const END = "\\s*$";
const PATTERNS: readonly { readonly kind: PercentageKind; readonly re: RegExp; readonly pct: 1 | 2; readonly base: 1 | 2 }[] = [
  { kind: "tip", re: new RegExp(`${LEAD}(?:a\\s+)?${PCT}\\s+tip\\s+(?:on|of|for)\\s+${NUM}${END}`, "u"), pct: 1, base: 2 },
  { kind: "off", re: new RegExp(`${LEAD}${PCT}\\s+off\\s+(?:of\\s+)?${NUM}${END}`, "u"), pct: 1, base: 2 },
  { kind: "off", re: new RegExp(`${LEAD}${NUM}\\s+(?:with\\s+)?${PCT}\\s+off${END}`, "u"), pct: 2, base: 1 },
  { kind: "increase", re: new RegExp(`${LEAD}${NUM}\\s+(?:plus|\\+|increased\\s+by)\\s+${PCT}${END}`, "u"), pct: 2, base: 1 },
  { kind: "increase", re: new RegExp(`${LEAD}add\\s+${PCT}\\s+to\\s+${NUM}${END}`, "u"), pct: 1, base: 2 },
  { kind: "decrease", re: new RegExp(`${LEAD}${NUM}\\s+(?:minus|decreased\\s+by|less)\\s+${PCT}${END}`, "u"), pct: 2, base: 1 },
  { kind: "of", re: new RegExp(`${LEAD}${PCT}\\s+of\\s+${NUM}${END}`, "u"), pct: 1, base: 2 }
];

function parseNumber(raw: string): number {
  return Number.parseFloat(raw.replace(/,/gu, ""));
}

/**
 * Detect a pure percentage question and return its parts, or null. Handles
 * "X% of Y", "X% off [of] Y" / "Y with X% off", "Y plus/increased by X%" /
 * "add X% to Y", "Y minus/decreased by X%", and "X% tip on Y". Returns null
 * unless the whole query is one of these, so recall is never hijacked.
 */
export function detectPercentageQuery(query: string): PercentageQuery | null {
  const q = query.trim().toLowerCase().replace(/[?.!]+$/u, "").trim();
  for (const { kind, re, pct, base } of PATTERNS) {
    const m = re.exec(q);
    if (m) {
      const percent = Number.parseFloat(m[pct]!);
      const base_ = parseNumber(m[base]!);
      if (Number.isFinite(percent) && Number.isFinite(base_)) {
        return { kind, percent, base: base_, currency: q.includes("$") ? "$" : "" };
      }
    }
  }
  return null;
}

/** Round to ≤2 decimals and drop trailing zeros: 68 → "68", 9.7 → "9.7", 9.725 → "9.73". */
function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/** The exact answer for a detected percentage query, framed per kind. Pure. */
export function formatPercentage(q: PercentageQuery): string {
  const c = q.currency;
  const base = `${c}${fmt(q.base)}`;
  const pct = `${q.percent.toString()}%`;
  switch (q.kind) {
    case "of": {
      return `${pct} of ${base} is ${c}${fmt(q.base * q.percent / 100)}.`;
    }
    case "off": {
      const saved = q.base * q.percent / 100;
      return `${pct} off ${base} is ${c}${fmt(q.base - saved)} (you save ${c}${fmt(saved)}).`;
    }
    case "increase": {
      return `${base} plus ${pct} is ${c}${fmt(q.base * (1 + q.percent / 100))}.`;
    }
    case "decrease": {
      return `${base} minus ${pct} is ${c}${fmt(q.base * (1 - q.percent / 100))}.`;
    }
    case "tip": {
      const tip = q.base * q.percent / 100;
      return `A ${pct} tip on ${base} is ${c}${fmt(tip)} (total ${c}${fmt(q.base + tip)}).`;
    }
  }
}
