import { calibrateAbstention } from "@muse/agent-core";

import { DEFAULT_EMBED_MODEL } from "./commands-notes-rag.js";
import { resolveOllamaUrl } from "./ollama-url.js";
import type { ProgramIO } from "./program.js";
import { probeOllamaModels } from "./ollama-probe.js";

/** Parse `--alpha` into a miss-rate in (0,1); default 0.1. Non-numeric / out-of-range → 0.1. */
export function parseAlpha(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    return 0.1;
  }
  return parsed;
}

export interface CalibrationReport {
  readonly alpha: number;
  readonly targetCoverage: number;
  readonly threshold: number;
  readonly n: number;
  readonly calibrationCoverage: number;
  readonly refuseTotal: number;
  readonly refuseHeld: number;
}

/**
 * Build the conformal calibration readout. `positiveScores` are the retrieval
 * confidence scores of ANSWERABLE items (the threshold must keep these answered);
 * `negativeScores` are the scores of items that SHOULD be refused (a good
 * threshold holds these below it). Pure — the conformal math is in agent-core.
 */
export function buildCalibrationReport(
  positiveScores: readonly number[],
  negativeScores: readonly number[],
  alpha: number
): CalibrationReport {
  const { threshold, calibrationCoverage, n, targetCoverage } = calibrateAbstention(positiveScores, alpha);
  const refuseHeld = negativeScores.reduce((count, score) => (score < threshold ? count + 1 : count), 0);
  return { alpha, calibrationCoverage, n, refuseHeld, refuseTotal: negativeScores.length, targetCoverage, threshold };
}

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;

/** Render the calibration readout as an honest table across the requested alphas. */
export function formatCalibration(reports: readonly CalibrationReport[]): string {
  if (reports.length === 0 || reports[0]!.n === 0) {
    return "🎯 Calibration: no answerable calibration items — nothing to calibrate.\n";
  }
  const lines = [
    `🎯 Abstention calibration (conformal) — ${reports[0]!.n.toString()} answerable + ${reports[0]!.refuseTotal.toString()} should-refuse items`,
    "  α (miss)  target   threshold  answerable-kept  refuse-held",
    ...reports.map((r) => {
      const thr = Number.isFinite(r.threshold) ? r.threshold.toFixed(3) : (r.threshold > 0 ? "+inf" : "-inf");
      return `  ${r.alpha.toFixed(2)}      ≥${pct(r.targetCoverage)}   ${thr.padStart(7)}   ${pct(r.calibrationCoverage).padStart(10)}      ${`${r.refuseHeld.toString()}/${r.refuseTotal.toString()}`.padStart(7)}`;
    })
  ];
  return `${lines.join("\n")}\n`;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function runCalibrationDoctor(io: ProgramIO, alpha: number, asJson: boolean): Promise<void> {
  const baseUrl = resolveOllamaUrl().replace(/\/$/, "");
  const reachable = (await probeOllamaModels(baseUrl, { timeoutMs: 3_000 })).reachable;
  if (!reachable) {
    io.stdout(`calibration — skipped: local Ollama not reachable at ${baseUrl} (a skip is not a pass; start Ollama to measure).\n`);
    return;
  }
  const { createOllamaEmbedder } = await import("@muse/autoconfigure");
  const { GROUNDING_EVAL_CORPUS } = await import("./grounding-eval-corpus.js");
  const embed = createOllamaEmbedder(DEFAULT_EMBED_MODEL);
  let noteVecs: number[][];
  try {
    noteVecs = await Promise.all(GROUNDING_EVAL_CORPUS.notes.map((note) => embed(note.text) as Promise<number[]>));
  } catch (cause) {
    io.stdout(`calibration — skipped: embed model '${DEFAULT_EMBED_MODEL}' unavailable (${cause instanceof Error ? cause.message : String(cause)}).\n`);
    return;
  }
  const topCosine = async (query: string): Promise<number> => {
    const q = (await embed(query)) as number[];
    return noteVecs.reduce((best, vec) => Math.max(best, cosine(q, vec)), Number.NEGATIVE_INFINITY);
  };
  const positives: number[] = [];
  const negatives: number[] = [];
  for (const testCase of GROUNDING_EVAL_CORPUS.cases) {
    if (testCase.kind === "answerable") {
      positives.push(await topCosine(testCase.query));
    } else if (testCase.kind === "refuse") {
      negatives.push(await topCosine(testCase.query));
    }
  }
  const reports = [...new Set([0.05, alpha, 0.2])].sort((a, b) => a - b).map((a) => buildCalibrationReport(positives, negatives, a));
  if (asJson) {
    io.stdout(`${JSON.stringify({ alpha, reports }, null, 2)}\n`);
    return;
  }
  io.stdout(formatCalibration(reports));
  // The chat grounding gate (chat-grounding.ts) reads MUSE_GROUNDING_MIN_COSINE
  // as an opt-in override of its 0.5 default — print how to apply the value the
  // requested alpha calibrated to, so the calibration actually reaches the gate.
  const chosen = reports.find((report) => report.alpha === alpha);
  if (chosen && Number.isFinite(chosen.threshold)) {
    io.stdout(`\n  Apply (opt-in): export MUSE_GROUNDING_MIN_COSINE=${chosen.threshold.toFixed(3)}   # the α=${alpha.toFixed(2)} threshold; the chat gate stays at 0.5 until set\n`);
  }
}
