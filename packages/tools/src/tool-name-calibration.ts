/**
 * PA-Tool style tool-name calibration (arXiv 2510.07248): discover the
 * name the local model spontaneously expects and recommend a rename only
 * when it beats the current name's one-shot selection rate by a margin.
 * This module is the pure, model-free decision core; the live probe +
 * selection measurement live in scripts/calibrate-tool-names.mjs.
 */

export function normalizeToolName(raw: string): string {
  if (typeof raw !== "string") return "";
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[`'"]+|[`'"]+$/g, "").trim();
  s = s.replace(/[\s.-]+/g, "_");
  s = s.replace(/[^a-z0-9_]/g, "");
  s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z][a-z0-9_]*$/.test(s) ? s : "";
}

export function extractCandidateNames(raw: string): string[] {
  if (typeof raw !== "string") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  };
  const multi = raw.match(/[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+/g) ?? [];
  for (const m of multi) push(normalizeToolName(m));
  if (out.length > 0) return out;
  const trimmed = raw.trim().replace(/^[`'"]+|[`'"]+$/g, "").trim();
  if (trimmed.length > 0 && trimmed.length <= 40 && !/\s/.test(trimmed)) {
    push(normalizeToolName(trimmed));
  }
  return out;
}

export interface PeakednessRow {
  readonly name: string;
  readonly count: number;
  readonly share: number;
}

export function tallyPeakedness(samples: readonly string[]): PeakednessRow[] {
  const counts = new Map<string, number>();
  let totalValid = 0;
  for (const sample of samples) {
    const name = normalizeToolName(sample);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    totalValid += 1;
  }
  if (totalValid === 0) return [];
  const rows = [...counts.entries()].map(([name, count]) => ({
    name,
    count,
    share: count / totalValid
  }));
  rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return rows;
}

export interface RenameCandidate {
  readonly name: string;
  readonly rate: number;
  readonly siblingRegression: boolean;
  readonly collidesWithSibling: boolean;
}

export interface RenameDecisionInput {
  readonly current: string;
  readonly baselineRate: number;
  readonly candidates: readonly RenameCandidate[];
  readonly margin: number;
}

export interface RenameDecision {
  readonly recommend: boolean;
  readonly from: string;
  readonly to?: string;
  readonly reason: string;
}

export function recommendRename(input: RenameDecisionInput): RenameDecision {
  const { current, baselineRate, candidates, margin } = input;
  const threshold = baselineRate + margin;
  if (candidates.length === 0) {
    return { recommend: false, from: current, reason: "no valid candidate discovered" };
  }
  const qualifying = candidates
    .filter((c) => c.name !== current && c.rate >= threshold && !c.siblingRegression && !c.collidesWithSibling)
    .sort((a, b) => b.rate - a.rate);
  const best = qualifying[0];
  if (best) {
    return {
      recommend: true,
      from: current,
      to: best.name,
      reason: `selection rate ${best.rate.toFixed(2)} beats baseline ${baselineRate.toFixed(2)} by >= margin ${margin.toFixed(2)}`
    };
  }
  const metMargin = candidates.filter((c) => c.name !== current && c.rate >= threshold);
  if (metMargin.some((c) => c.collidesWithSibling)) {
    return { recommend: false, from: current, reason: "best candidate rejected: name collision with sibling tool" };
  }
  if (metMargin.some((c) => c.siblingRegression)) {
    return { recommend: false, from: current, reason: "best candidate rejected: it regresses a sibling tool's selection" };
  }
  return { recommend: false, from: current, reason: `no candidate beats baseline ${baselineRate.toFixed(2)} by margin ${margin.toFixed(2)}` };
}

export interface CalibrationResult {
  readonly tool: string;
  readonly job: string;
  readonly peakedness: readonly PeakednessRow[];
  readonly baselineRate: number;
  readonly candidates: readonly RenameCandidate[];
  readonly decision: RenameDecision;
}

export function formatCalibrationReport(results: readonly CalibrationResult[]): {
  text: string;
  json: readonly CalibrationResult[];
} {
  const lines: string[] = [];
  for (const r of results) {
    const leader = r.peakedness[0];
    const peak = leader ? `${leader.name} ${(leader.share * 100).toFixed(0)}%` : "(none)";
    lines.push(`■ ${r.tool}  baseline=${(r.baselineRate * 100).toFixed(0)}%  model-preferred=${peak}`);
    for (const c of r.candidates) {
      const flags = [c.collidesWithSibling ? "collision" : "", c.siblingRegression ? "sibling-regress" : ""].filter(Boolean).join(",");
      lines.push(`    candidate ${c.name}: ${(c.rate * 100).toFixed(0)}%${flags ? ` [${flags}]` : ""}`);
    }
    const verdict = r.decision.recommend ? `RENAME → ${r.decision.to}` : "keep current";
    lines.push(`    → ${verdict} (${r.decision.reason})`);
  }
  return { text: lines.join("\n"), json: results };
}
