/** Explicit controls for the thread-scoped continuity timing loop. */

import { resolveAttunementFile } from "@muse/autoconfigure";
import {
  evaluateTimingSession,
  forgetTimingSession,
  inspectTimingSession,
  pauseTimingSession,
  readAttunementState,
  readTimingState,
  recordTimingFeedback,
  recordTimingObservation,
  resumeTimingSession,
  startTimingSession,
  TIMING_APP_CATEGORIES,
  type ContinuityOutcome,
  type TimingAppCategory
} from "@muse/attunement";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

function environment(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}

function timingFile(): string {
  return `${resolveAttunementFile(environment())}.timing.json`;
}

function write(io: ProgramIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(io: ProgramIO, cause: unknown): void {
  io.stderr(`timing: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 2;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

function assertCategory(value: string): TimingAppCategory {
  if (!TIMING_APP_CATEGORIES.includes(value as TimingAppCategory)) {
    throw new Error(`category must be one of: ${TIMING_APP_CATEGORIES.join(", ")}`);
  }
  return value as TimingAppCategory;
}

function assertOutcome(value: string): ContinuityOutcome {
  if (!["used", "adjusted", "ignored", "rejected"].includes(value)) {
    throw new Error("outcome must be used, adjusted, ignored, or rejected");
  }
  return value as ContinuityOutcome;
}

async function assertKnownThread(threadId: string): Promise<void> {
  const state = await readAttunementState(resolveAttunementFile(environment()));
  if (!state.threads.some((thread) => thread.id === threadId)) throw new Error(`no personal thread with id '${threadId}'`);
}

export function registerTimingCommands(program: Command, io: ProgramIO): void {
  const timing = program.command("timing").description("explicit, local-only timing controls for one personal thread");

  timing.command("start <threadId>")
    .requiredOption("--consent-version <version>", "visible consent revision for this session")
    .action(async (threadId: string, options: { readonly consentVersion: string }) => {
      try {
        write(io, await startTimingSession(timingFile(), { consentVersion: parsePositiveInteger(options.consentVersion, "consent version"), threadId }, assertKnownThread));
      } catch (cause) { fail(io, cause); }
    });

  timing.command("pause <sessionId>").action(async (sessionId: string) => {
    try { write(io, await pauseTimingSession(timingFile(), sessionId)); } catch (cause) { fail(io, cause); }
  });

  timing.command("resume <sessionId>").action(async (sessionId: string) => {
    try { write(io, await resumeTimingSession(timingFile(), sessionId)); } catch (cause) { fail(io, cause); }
  });

  timing.command("forget <sessionId>").description("delete this session and every timing receipt").action(async (sessionId: string) => {
    try { write(io, await forgetTimingSession(timingFile(), sessionId)); } catch (cause) { fail(io, cause); }
  });

  timing.command("inspect <sessionId>").action(async (sessionId: string) => {
    try { write(io, inspectTimingSession(await readTimingState(timingFile()), sessionId)); } catch (cause) { fail(io, cause); }
  });

  timing.command("record <sessionId>")
    .requiredOption("--category <category>", `one of: ${TIMING_APP_CATEGORIES.join(", ")}`)
    .requiredOption("--duration-ms <duration>", "positive duration in milliseconds")
    .requiredOption("--started-at <iso>", "ISO-8601 start timestamp")
    .requiredOption("--ended-at <iso>", "ISO-8601 end timestamp")
    .action(async (sessionId: string, options: { readonly category: string; readonly durationMs: string; readonly endedAt: string; readonly startedAt: string }) => {
      try {
        write(io, await recordTimingObservation(timingFile(), sessionId, {
          appCategory: assertCategory(options.category),
          durationMs: parsePositiveInteger(options.durationMs, "duration"),
          endedAt: options.endedAt,
          startedAt: options.startedAt
        }));
      } catch (cause) { fail(io, cause); }
    });

  timing.command("evaluate <sessionId>").description("derive a local-only silent, digest, or offer candidate").action(async (sessionId: string) => {
    try { write(io, await evaluateTimingSession(timingFile(), sessionId)); } catch (cause) { fail(io, cause); }
  });

  timing.command("feedback <candidateId> <outcome>").action(async (candidateId: string, outcome: string) => {
    try { write(io, await recordTimingFeedback(timingFile(), candidateId, assertOutcome(outcome))); } catch (cause) { fail(io, cause); }
  });
}
