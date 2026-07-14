/**
 * `muse resume` — fault-tolerant execution. A run that crashed or was interrupted
 * mid-tool-loop persisted a per-step checkpoint (the messages-so-far incl. completed
 * tool results). This command lists such runs and re-runs one from its last
 * checkpoint: resumeRunInputFromCheckpoint replays the completed tool results so the
 * resumed run continues from where it stopped WITHOUT re-executing finished tools.
 */

import type { Command } from "commander";

import { resumeRunInputFromCheckpoint, type AgentCheckpointState } from "@muse/agent-core";
import { createMuseRuntimeAssembly, FileCheckpointStore, resolveCheckpointsDir, type MuseEnvironment } from "@muse/autoconfigure";

import type { ProgramIO } from "./program.js";

export interface ResumableRunRow {
  readonly runId: string;
  readonly step: number;
  readonly phase: string;
  readonly updatedAt: Date;
}

/** Pretty-print the resumable-run list (pure; exported for tests). */
export function formatResumableRuns(runs: readonly ResumableRunRow[]): string {
  if (runs.length === 0) {
    return "No interrupted runs to resume — everything completed cleanly.";
  }
  const lines = ["Interrupted runs (resume with `muse resume <run-id>`):"];
  for (const r of runs) {
    lines.push(`  ${r.runId}  — stopped at step ${r.step.toString()} (${r.phase}), ${r.updatedAt.toISOString()}`);
  }
  return lines.join("\n");
}

export function registerResumeCommand(program: Command, io: ProgramIO): void {
  program
    .command("resume")
    .description("Resume a crashed/interrupted run from its last checkpoint (fault-tolerant execution)")
    .argument("[run-id]", "The run to resume; omit to LIST resumable (interrupted) runs")
    .action(async (runId: string | undefined) => {
      const store = new FileCheckpointStore(resolveCheckpointsDir(process.env));
      if (!runId) {
        io.stdout(`${formatResumableRuns(await store.listResumable())}\n`);
        return;
      }
      const latest = await store.findResumableCheckpoint(runId);
      if (!latest) {
        io.stderr(`No resumable checkpoint for run '${runId}' (it may have completed). Run \`muse resume\` to list resumable runs.\n`);
        return;
      }
      const assembly = createMuseRuntimeAssembly({});
      if (!assembly.agentRuntime) {
        io.stderr("No model is configured, so the run can't be resumed.\n");
        return;
      }
      // A corrupt/garbled checkpoint makes resumeRunInputFromCheckpoint throw
      // (ModelRoutingError); a runtime failure rethrows. Catch both → a clean message,
      // never an unhandled-rejection stack, and DON'T delete the checkpoint on failure
      // so the run stays resumable.
      let input;
      try {
        input = resumeRunInputFromCheckpoint(latest.state as AgentCheckpointState, { runId });
      } catch {
        io.stderr(`The checkpoint for '${runId}' is corrupt and can't be resumed.\n`);
        return;
      }
      io.stderr(`Resuming '${runId}' from step ${latest.step.toString()}…\n`);
      try {
        const result = await assembly.agentRuntime.run(input);
        io.stdout(`${result.response.output}\n`);
      } catch (error) {
        io.stderr(`Resume of '${runId}' failed: ${error instanceof Error ? error.message : String(error)}. It stays resumable — try again.\n`);
        return;
      }
      // The resumed run reached completion — clear its checkpoints so it isn't
      // offered for resume again.
      await store.deleteByRunId(runId);
    });
}
