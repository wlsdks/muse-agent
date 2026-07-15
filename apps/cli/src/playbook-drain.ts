/**
 * `muse playbook drain` — the manual, explicit counterpart to the daemon's
 * idle self-learn tick (`daemon-selflearn-ticks.ts`): distill EVERY pending
 * queued correction right now instead of waiting for `muse daemon`'s
 * one-per-tick pace. Same `distillQueuedCorrections` primitive, same file
 * wiring (queue / playbook / suppressed-lessons / pause) — the only
 * difference is `maxPerTick`, set to the whole pending backlog so a user who
 * ran `muse daemon` rarely can catch the queue up in one command.
 */
import { createGateEmbedder, resolveLearningPauseFile, resolvePlaybookFile, resolveSuppressedLessonsFile, distillQueuedCorrections, type DistillQueuedDeps } from "@muse/autoconfigure";
import { isLearningPaused, readPendingLearnEvents, resolveLearnQueueFile } from "@muse/stores";
import type { ModelProvider } from "@muse/model";

export interface RunLearnQueueDrainDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly model: string;
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly stdout: (line: string) => void;
  /** Test seam — mirrors `DistillQueuedDeps["distill"]`. Absent → the real local distiller. */
  readonly distill?: DistillQueuedDeps["distill"];
}

export type LearnQueueDrainStatus = "drained" | "empty" | "paused";

export interface LearnQueueDrainResult {
  readonly status: LearnQueueDrainStatus;
  readonly pending: number;
  readonly learned: number;
}

export async function runLearnQueueDrain(deps: RunLearnQueueDrainDeps): Promise<LearnQueueDrainResult> {
  const queueFile = resolveLearnQueueFile(deps.env);
  const playbookFile = resolvePlaybookFile(deps.env);
  const pauseFile = resolveLearningPauseFile(deps.env);
  const suppressedLessonsFile = resolveSuppressedLessonsFile(deps.env);

  const pending = await readPendingLearnEvents(queueFile);
  if (pending.length === 0) {
    deps.stdout("(learn queue empty — nothing to drain)\n");
    return { learned: 0, pending: 0, status: "empty" };
  }

  if (await isLearningPaused(pauseFile)) {
    deps.stdout(`Background learning is paused (${pending.length.toString()} correction(s) waiting) — run \`muse playbook resume\` first.\n`);
    return { learned: 0, pending: pending.length, status: "paused" };
  }

  const recorded = await distillQueuedCorrections({
    embed: createGateEmbedder(deps.env),
    maxPerTick: pending.length,
    model: deps.model,
    modelProvider: deps.modelProvider,
    pauseFile,
    playbookFile,
    queueFile,
    suppressedLessonsFile,
    ...(deps.distill ? { distill: deps.distill } : {})
  });

  deps.stdout(
    `Learned ${recorded.toString()} strateg${recorded === 1 ? "y" : "ies"} from ${pending.length.toString()} queued correction(s) — see \`muse learned\`.\n`
  );
  return { learned: recorded, pending: pending.length, status: "drained" };
}
