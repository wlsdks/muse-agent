import { analyzeApprovalRates, RUBBER_STAMP_APPROVAL_RATE_THRESHOLD, RUBBER_STAMP_MIN_SAMPLE_SIZE, type ApprovalRateSummary } from "@muse/proactivity";
import { resolveActionLogFile } from "@muse/autoconfigure";
import { readActionLog } from "@muse/stores";

import type { ProgramIO } from "./program.js";

/**
 * Render the approval-rate report: per-gate-class prompt/approve/deny counts
 * and an honest "rubber stamp" callout when a class is being reflexively
 * approved (`analyzeApprovalRates`'s thresholds). This MEASURES only — it
 * never changes gate behaviour; converting a flagged class into a
 * pre-approved safe boundary is a separate, human-approved decision. Pure (no
 * I/O) so it is unit-testable against real action-log-shaped fixtures.
 */
export function formatApprovalRateDoctor(summary: ApprovalRateSummary): string {
  if (summary.gates.length === 0) {
    return "🖐 Approval gates: no gate-classed action-log entries recorded yet.\n";
  }
  const pct = (rate: number): string => `${(rate * 100).toFixed(0)}%`;
  const lines = summary.gates.map((gate) => {
    const base = `  • ${gate.gateClass}: ${gate.prompted.toString()} prompt${gate.prompted === 1 ? "" : "s"}, `
      + `${gate.approved.toString()} approved (${pct(gate.approvalRate)})`
      + (gate.executionFailed > 0 ? ` [${gate.executionFailed.toString()} execution failure${gate.executionFailed === 1 ? "" : "s"}]` : "");
    return gate.rubberStamped
      ? `${base} — this gate is a rubber stamp; consider a pre-approved safe boundary instead of a prompt.`
      : base;
  });
  const thresholdNote = `${RUBBER_STAMP_MIN_SAMPLE_SIZE.toString()}+ prompts, ≥${pct(RUBBER_STAMP_APPROVAL_RATE_THRESHOLD)} approved`;
  const head = summary.rubberStampedClasses.length > 0
    ? `🖐 Approval gates: ${summary.rubberStampedClasses.length.toString()} of ${summary.gates.length.toString()} gate class${summary.gates.length === 1 ? "" : "es"} looks like a rubber stamp (${thresholdNote}):`
    : `🖐 Approval gates: ${summary.gates.length.toString()} gate class${summary.gates.length === 1 ? "" : "es"} tracked, none reflexively approved yet (flag line: ${thresholdNote}).`;
  return `${head}\n${lines.join("\n")}\n`;
}

export async function runApprovalRateDoctor(io: ProgramIO, asJson: boolean): Promise<void> {
  const env = process.env;
  const entries = await readActionLog(resolveActionLogFile(env));
  const summary = analyzeApprovalRates(entries);
  if (asJson) {
    io.stdout(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  io.stdout(formatApprovalRateDoctor(summary));
}
