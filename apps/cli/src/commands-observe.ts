/** Explicit controls for opt-in, category-only Observe collection. */

import { resolveAttunementFile } from "@muse/autoconfigure";
import {
  forgetObserveSession,
  inspectObserveSession,
  OBSERVE_CONSENT_TERMS,
  OBSERVE_CONSENT_VERSION,
  observeStatus,
  pauseObserveSession,
  resumeObserveSessionSafe,
  startObserveSessionSafe
} from "@muse/attunement";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

function environment(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}

function files(): { readonly attunementFile: string; readonly observeFile: string } {
  const attunementFile = resolveAttunementFile(environment());
  return { attunementFile, observeFile: `${attunementFile}.observe.json` };
}

function write(io: ProgramIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(io: ProgramIO, cause: unknown): void {
  io.stderr(`observe: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 2;
}

function parseVersion(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("--accept-version must be an integer");
  return parsed;
}

export function registerObserveCommands(program: Command, io: ProgramIO): void {
  const observe = program.command("observe").description("opt-in, local-only app-category collection for one exact PersonalThread");

  observe.command("consent").description("show the exact Observe consent terms").action(() => {
    write(io, { terms: OBSERVE_CONSENT_TERMS, version: OBSERVE_CONSENT_VERSION });
  });

  observe.command("start <threadId>")
    .requiredOption("--accept-version <version>", "accept exactly the displayed consent version")
    .action(async (threadId: string, options: { readonly acceptVersion: string }) => {
      try { write(io, await startObserveSessionSafe(files(), { acceptVersion: parseVersion(options.acceptVersion), threadId })); }
      catch (cause) { fail(io, cause); }
    });

  observe.command("status").action(async () => {
    try { write(io, await observeStatus(files().observeFile)); } catch (cause) { fail(io, cause); }
  });

  observe.command("inspect <sessionId>").action(async (sessionId: string) => {
    try { write(io, await inspectObserveSession(files().observeFile, sessionId)); } catch (cause) { fail(io, cause); }
  });

  observe.command("pause <sessionId>").action(async (sessionId: string) => {
    try { write(io, await pauseObserveSession(files().observeFile, sessionId)); } catch (cause) { fail(io, cause); }
  });

  observe.command("resume <sessionId>").action(async (sessionId: string) => {
    try { write(io, await resumeObserveSessionSafe(files(), sessionId)); } catch (cause) { fail(io, cause); }
  });

  observe.command("forget <sessionId>").description("permanently delete the session and its observations").action(async (sessionId: string) => {
    try { write(io, await forgetObserveSession(files().observeFile, sessionId)); } catch (cause) { fail(io, cause); }
  });
}
