import { errorMessage } from "@muse/shared";
/**
 * Self-contained helpers lifted out of the `muse proactive watch`
 * action so its handler reads as orchestration rather than one
 * ~235-LOC god-function. Behaviour-preserving — each helper takes its
 * inputs explicitly and returns what the caller threaded inline before.
 */

import type { buildMessagingRegistry } from "@muse/autoconfigure";
import { buildGroundingReverify } from "@muse/agent-core";
import { readTasks, type PersistedTask } from "@muse/stores";
import { runDueProactiveNotices } from "@muse/proactivity";

import type { ProgramIO } from "./program.js";

type MessagingRegistry = ReturnType<typeof buildMessagingRegistry>;

type RunNoticesOptions = Parameters<typeof runDueProactiveNotices>[0];

export interface ProactiveTickContext {
  readonly io: Pick<ProgramIO, "stdout" | "stderr">;
  readonly agentModel: string | undefined;
  readonly modelProvider: RunNoticesOptions["modelProvider"];
  readonly personaPreamble: string | undefined;
  readonly terminalSink: RunNoticesOptions["terminalSink"];
  readonly calendarRegistry: NonNullable<RunNoticesOptions["calendarRegistry"]>;
  readonly destination: string;
  readonly historyFile: string;
  readonly proactiveInvestigator: RunNoticesOptions["investigate"];
  readonly leadMinutes: number;
  readonly effectiveMessagingRegistry: RunNoticesOptions["messagingRegistry"];
  readonly provider: string;
  readonly sidecarFile: string;
  readonly tasksFile: string;
  readonly trustLedgerFile: string;
  readonly dailyCap: number;
}

/**
 * Wrap the messaging registry so every successful `send` ALSO fires the
 * TTS — log file + speaker stay in sync. Returns the registry unchanged
 * when `--speak` resolved no TTS (`speakFn` undefined).
 */
export function buildSpeakingRegistry(
  messagingRegistry: MessagingRegistry,
  speakFn: ((text: string) => Promise<void>) | undefined
): MessagingRegistry {
  if (!speakFn) {
    return messagingRegistry;
  }
  return new Proxy(messagingRegistry, {
    get(target, prop, receiver) {
      if (prop === "send") {
        return async (providerId: string, message: { destination: string; text: string }) => {
          const result = await target.send(providerId, message);
          void speakFn(message.text);
          return result;
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

/**
 * Parse the `routine_active_hours` fact (e.g. "09,14,20") into the set
 * of "active" hours, each widened by ±2 so even a one-data-point user
 * gets a sensible quiet-hours window. Returns undefined when the raw
 * value is absent or yields no valid hour.
 */
export function resolveActiveHourBand(routineRaw: unknown): Set<number> | undefined {
  if (!routineRaw || typeof routineRaw !== "string") {
    return undefined;
  }
  const hours = routineRaw.split(",")
    .map((h) => Number.parseInt(h.trim(), 10))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  if (hours.length === 0) {
    return undefined;
  }
  const activeHourSet = new Set<number>();
  for (const h of hours) {
    for (let off = -2; off <= 2; off += 1) {
      activeHourSet.add((h + off + 24) % 24);
    }
  }
  return activeHourSet;
}

/**
 * Quiet-hours override probe: any open task flagged `urgent: true` whose
 * dueAt falls inside [startedAt, startedAt + leadMinutes]. Fail-open —
 * a read error returns false (fall through to skip).
 */
export async function hasUrgentImminentTask(
  tasksFile: string,
  startedAt: Date,
  leadMinutes: number
): Promise<boolean> {
  try {
    const tasksNow = await readTasks(tasksFile);
    const cutoff = startedAt.getTime() + leadMinutes * 60_000;
    return tasksNow.some((t: PersistedTask) =>
      t.status === "open"
      && t.urgent === true
      && typeof t.dueAt === "string"
      && new Date(t.dueAt).getTime() <= cutoff
      && new Date(t.dueAt).getTime() >= startedAt.getTime()
    );
  } catch {
    return false;
  }
}

/**
 * One tick of the watch loop: fire due proactive notices and report the
 * outcome. The quiet-hours gate, sleeps, and stop handling stay in the
 * caller's loop — this body only runs the notices and writes the summary.
 */
export async function runProactiveTick(ctx: ProactiveTickContext, startedAt: Date): Promise<void> {
  const {
    io, agentModel, modelProvider, personaPreamble, terminalSink, calendarRegistry,
    destination, historyFile, proactiveInvestigator, leadMinutes, effectiveMessagingRegistry,
    provider, sidecarFile, tasksFile, trustLedgerFile, dailyCap
  } = ctx;
  try {
    const summary = await runDueProactiveNotices({
      ...(agentModel ? { agentModel } : {}),
      ...(modelProvider ? { modelProvider } : {}),
      // Faithfulness-gate the synthesized notice — a confabulated push
      // detail fails CLOSE to the verbatim store line (same judge as reflection).
      ...(modelProvider && agentModel ? { reverify: buildGroundingReverify(modelProvider, agentModel) } : {}),
      ...(personaPreamble ? { personaPreamble } : {}),
      ...(terminalSink
        ? { activitySource: { lastActivityMs: () => Date.now() }, terminalSink }
        : modelProvider
          ? { activitySource: { lastActivityMs: () => Date.now() } }
          : {}),
      ...(calendarRegistry.list().length > 0 ? { calendarRegistry } : {}),
      destination,
      historyFile,
      investigate: proactiveInvestigator,
      leadMinutes,
      messagingRegistry: effectiveMessagingRegistry,
      providerId: provider,
      sidecarFile,
      tasksFile,
      trustLedgerFile,
      ...(dailyCap > 0 ? { dailyCap } : {})
    });
    const tag = `[${startedAt.toISOString()}]`;
    if (summary.fired > 0 || summary.errors.length > 0) {
      io.stdout(`${tag} fired ${summary.fired.toString()}/${summary.imminent.toString()} imminent`);
      if (summary.errors.length > 0) {
        io.stdout(`, ${summary.errors.length.toString()} error(s)`);
        for (const error of summary.errors) {
          io.stdout(`\n  ! ${error}`);
        }
      }
      io.stdout("\n");
    } else {
      io.stdout(`${tag} 0/${summary.imminent.toString()} imminent (quiet)\n`);
    }
  } catch (cause) {
    io.stderr(`tick error: ${errorMessage(cause)}\n`);
  }
}

