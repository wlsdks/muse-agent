/**
 * Benford's Law conformity — a forensic-statistics check on a column of numbers.
 * In many naturally-occurring datasets that span several orders of magnitude
 * (expenses, transaction amounts, populations), the LEADING digit d is not
 * uniform: it follows P(d) = log10(1 + 1/d), so "1" leads ~30.1% of the time and
 * "9" only ~4.6% (Newcomb 1881; Benford, "The Law of Anomalous Numbers", Proc.
 * Amer. Phil. Soc. 78(4):551-572, 1938). A column that DEVIATES is worth a look:
 * data-entry errors, a capped/rounded field, duplicated rows, or manipulation.
 *
 * Conformity is judged by PEARSON'S CHI-SQUARE goodness-of-fit (Pearson 1900) of
 * the observed leading-digit counts against the Benford expectation — chosen over
 * Nigrini's fixed-threshold MAD because chi-square is SAMPLE-SIZE-AWARE: a small
 * personal dataset (a few hundred expenses) carries real sampling noise, and a
 * fixed MAD cutoff cries wolf on it, while the chi-square critical value scales
 * the bar to the sample. (df = 8; critical χ² = 15.51 at p=0.05, 20.09 at p=0.01.)
 *
 * Honest scope: Benford is meaningful only for naturally-occurring, multi-
 * magnitude numbers — NOT bounded values (ages, scores, percentages), which
 * legitimately deviate. The report says so; it flags "worth a look", not "fraud".
 */

/** First significant digit (1-9) of a number's magnitude; undefined for 0 / non-finite. */
export function leadingDigit(value: number): number | undefined {
  if (!Number.isFinite(value) || value === 0) return undefined;
  let x = Math.abs(value);
  while (x >= 10) x /= 10;
  while (x < 1) x *= 10;
  const d = Math.floor(x);
  return d >= 1 && d <= 9 ? d : undefined;
}

/** Benford-expected frequency of leading digit d (1-9): log10(1 + 1/d). */
export function benfordExpected(d: number): number {
  return Math.log10(1 + 1 / d);
}

export type BenfordConformity = "consistent" | "deviates" | "strong-deviation" | "insufficient";

// Below this many usable values the first-digit test is unreliable.
const MIN_BENFORD_SAMPLE = 30;
// Chi-square critical values at df = 8 (nine digits minus one).
const CHI2_CRIT_P05 = 15.507;
const CHI2_CRIT_P01 = 20.090;

export interface BenfordResult {
  /** Count of usable (non-zero, finite) values analyzed. */
  readonly sampleSize: number;
  /** counts[d] for d in 1..9 (index 0 unused). */
  readonly counts: readonly number[];
  /** observedFreq[d] for d in 1..9 (index 0 unused). */
  readonly observedFreq: readonly number[];
  /** Pearson chi-square statistic of observed vs Benford-expected counts (df = 8). */
  readonly chiSquare: number;
  readonly conformity: BenfordConformity;
  /** The digit whose observed frequency most EXCEEDS its expected (the standout), or undefined. */
  readonly mostOverrepresented?: { readonly digit: number; readonly observed: number; readonly expected: number };
}

/** Analyze the leading-digit distribution of a column's values against Benford's Law. */
export function analyzeBenford(values: readonly number[]): BenfordResult {
  const counts = new Array<number>(10).fill(0);
  let sampleSize = 0;
  for (const value of values) {
    const d = leadingDigit(value);
    if (d !== undefined) {
      counts[d] = (counts[d] ?? 0) + 1;
      sampleSize += 1;
    }
  }
  const observedFreq = new Array<number>(10).fill(0);
  if (sampleSize === 0) {
    return { chiSquare: 0, conformity: "insufficient", counts, observedFreq, sampleSize };
  }
  let chiSquare = 0;
  let standout: BenfordResult["mostOverrepresented"];
  for (let d = 1; d <= 9; d += 1) {
    const observedCount = counts[d] ?? 0;
    const expectedFreq = benfordExpected(d);
    const expectedCount = expectedFreq * sampleSize;
    chiSquare += ((observedCount - expectedCount) ** 2) / expectedCount;
    const observed = observedCount / sampleSize;
    observedFreq[d] = observed;
    if (standout === undefined || observed - expectedFreq > standout.observed - standout.expected) {
      standout = { digit: d, expected: expectedFreq, observed };
    }
  }
  const conformity: BenfordConformity = sampleSize < MIN_BENFORD_SAMPLE
    ? "insufficient"
    : chiSquare >= CHI2_CRIT_P01
      ? "strong-deviation"
      : chiSquare >= CHI2_CRIT_P05
        ? "deviates"
        : "consistent";
  return { chiSquare, conformity, counts, mostOverrepresented: standout, observedFreq, sampleSize };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** Render the human-readable Benford report for a column. */
export function formatBenford(result: BenfordResult, column: string): string {
  if (result.sampleSize === 0) {
    return `No numeric values found in column '${column}' to check.\n`;
  }
  const lines = [`🔢 Benford's-Law check — column '${column}' (${result.sampleSize.toString()} values)`];
  lines.push("  digit  observed  expected");
  for (let d = 1; d <= 9; d += 1) {
    lines.push(`    ${d.toString()}    ${pct(result.observedFreq[d]!).padStart(7)}   ${pct(benfordExpected(d)).padStart(7)}`);
  }
  lines.push(`  chi-square: ${result.chiSquare.toFixed(2)} (df 8; ${CHI2_CRIT_P05.toString()} = p<0.05)`);
  if (result.conformity === "insufficient") {
    lines.push(`  ⚠ Only ${result.sampleSize.toString()} values — below ${MIN_BENFORD_SAMPLE.toString()}, the leading-digit test is unreliable; treat this as indicative only.`);
  } else if (result.conformity === "consistent") {
    lines.push("  ✓ Consistent with Benford's Law — the distribution looks natural.");
  } else {
    const over = result.mostOverrepresented;
    const standout = over ? ` Leading digit ${over.digit.toString()} appears ${pct(over.observed)} vs an expected ${pct(over.expected)}.` : "";
    const strength = result.conformity === "strong-deviation" ? "Strongly deviates (p<0.01)" : "Deviates (p<0.05)";
    lines.push(`  ⚠ ${strength} from Benford — worth a look (data-entry errors, rounding/caps, or duplicates).${standout}`);
  }
  lines.push("  Note: Benford applies to naturally-occurring multi-magnitude numbers (amounts, counts) — not bounded values like ages or scores, which deviate legitimately.");
  return `${lines.join("\n")}\n`;
}
