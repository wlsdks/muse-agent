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
  if (summary.labelled === 0) {
    return "📉 Run outcomes: no graded runs yet — ask a few grounded questions and check back.\n";
  }
  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  const head = `📉 Run outcomes over ${summary.labelled.toString()} graded run${summary.labelled === 1 ? "" : "s"}: `
    + `fail-rate ${pct(summary.failRate)} (${summary.grounded} grounded · ${summary.abstain} abstain · ${summary.ungrounded} ungrounded)`;
  if (summary.topFailingTopics.length === 0) {
    return `${head}\n`;
  }
  const topics = summary.topFailingTopics
    .map((t) => `  • ${t.topic} (${t.count.toString()}×)`)
    .join("\n");
  return `${head}\n  top failing topics:\n${topics}\n`;
}

/** Read the run-log outcome entries from `.muse/runs/*.jsonl` (best-effort; a missing dir / bad line is skipped). */
async function readRunOutcomeEntries(workspaceDir: string): Promise<RunOutcomeEntry[]> {
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
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          const record = parsed as { grounded?: unknown; message?: unknown };
          if (typeof record.message === "string") {
            entries.push({ grounded: typeof record.grounded === "string" ? record.grounded : null, message: record.message });
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
  const summary = analyzeRunOutcomes(entries);
  if (asJson) {
    io.stdout(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  io.stdout(formatRunOutcomes(summary));
}
