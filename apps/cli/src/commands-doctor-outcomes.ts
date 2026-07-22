import { promises as fs } from "node:fs";
import { join } from "node:path";

import { analyzeRunOutcomes, type RunOutcomeEntry, type RunOutcomeSummary } from "@muse/proactivity";

import type { ProgramIO } from "./program.js";

/**
 * Render the run-log failure-RATE report. Pure (no I/O) so it is unit-testable;
 * the rate is the denominator the cumulative weakness ledger lacks — it tells
 * "improving" from "just more usage".
 */
export function formatRunOutcomes(summary: RunOutcomeSummary): string {
  const scope = "technical grounding diagnostics, not personal usefulness";
  if (!summary.measurement) {
    return `📉 Run grounding diagnostics: no decision-grade unique runs yet — canonical timestamp and run provenance are required. (${scope})\n  action: muse doctor --run-outcomes\n`;
  }
  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  const { measurement } = summary;
  const outcomes = summary.canonicalOutcomes;
  const head = `📉 Run grounding diagnostics over ${measurement.value.denominator.toString()} unique graded run${measurement.value.denominator === 1 ? "" : "s"}: `
    + `technical failure-rate ${pct(measurement.value.numerator / measurement.value.denominator)} `
    + `(${outcomes.grounded.toString()} grounded · ${outcomes.abstain.toString()} abstain · ${outcomes.ungrounded.toString()} ungrounded · `
    + `${outcomes.misgrounded.toString()} misgrounded · ${outcomes.contested.toString()} contested · ${outcomes.error.toString()} error)`;
  const metadata = [
    `  scope: ${scope}`,
    `  evidence: ${measurement.evidenceClass} · source: ${measurement.source.id}@${measurement.source.version.toString()}`,
    `  denominator: ${measurement.value.denominator.toString()} canonical unique graded runs`,
    `  window: ${measurement.window.startedAt} → ${measurement.window.endedAt}`,
    `  freshness: ${measurement.freshness.status} as of ${measurement.freshness.asOf} (evaluated ${measurement.freshness.evaluatedAt})`,
    "  action: muse doctor --run-outcomes"
  ];
  if (summary.technicalTopFailingTopics.length === 0) {
    return `${head}\n${metadata.join("\n")}\n`;
  }
  const topics = summary.technicalTopFailingTopics
    .map((t) => `  • ${t.topic} (${t.count.toString()}×)`)
    .join("\n");
  return `${head}\n${metadata.join("\n")}\n  top technical failing topics:\n${topics}\n`;
}

/** Read the run-log outcome entries from `.muse/runs/*.jsonl` (best-effort; a missing dir / bad line is skipped). */
export async function readRunOutcomeEntries(workspaceDir: string): Promise<RunOutcomeEntry[]> {
  const runDir = join(workspaceDir, ".muse", "runs");
  let files: string[];
  try {
    files = (await fs.readdir(runDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const entries: RunOutcomeEntry[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(join(runDir, file), "utf8");
    } catch {
      continue;
    }
    const fileRunId = file.slice(0, -".jsonl".length);
    for (const [lineIndex, line] of text.split("\n").entries()) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          const record = parsed as { grounded?: unknown; message?: unknown; recordedAt?: unknown; runId?: unknown; type?: unknown };
          if (typeof record.message === "string") {
            entries.push({
              fileRunId,
              grounded: typeof record.grounded === "string" ? record.grounded : null,
              lineIndex,
              message: record.message,
              ...(typeof record.recordedAt === "string" ? { recordedAt: record.recordedAt } : {}),
              ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
              ...(typeof record.type === "string" ? { type: record.type } : {})
            });
          }
        }
      } catch {
        // a malformed run-log line is skipped, never fatal
      }
    }
  }
  return entries;
}

export async function runRunOutcomesDoctor(io: ProgramIO, asJson: boolean): Promise<void> {
  const entries = await readRunOutcomeEntries(io.workspaceDir ?? process.cwd());
  const summary = analyzeRunOutcomes(entries, { now: new Date() });
  if (asJson) {
    io.stdout(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  io.stdout(formatRunOutcomes(summary));
}
