/** Explicit controls for opt-in, category-only Observe collection. */

import { resolveAttunementFile } from "@muse/autoconfigure";
import {
  forgetObserveSession,
  inspectObserveSession,
  OBSERVE_CONSENT_FIELDS,
  OBSERVE_CONSENT_SOURCE,
  OBSERVE_CONSENT_TEMPLATE,
  OBSERVE_CONSENT_TERMS,
  OBSERVE_CONSENT_VERSION,
  OBSERVE_PAUSE_CONTROL,
  observeStatus,
  pauseObserveSession,
  resolveCanonicalObserveStateFile,
  resumeObserveSessionSafe,
  startObserveSessionSafe
} from "@muse/attunement";
import type { ObserveConsentField, ObserveConsentGrant } from "@muse/attunement";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

function environment(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}

function files(): { readonly attunementFile: string } {
  const attunementFile = resolveAttunementFile(environment());
  return { attunementFile };
}

async function observeFile(): Promise<string> { return resolveCanonicalObserveStateFile(files().attunementFile); }

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

function parseInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function parseConsent(options: {
  readonly cadenceMs: string;
  readonly fields: string;
  readonly pauseControl: string;
  readonly retentionDays: string;
  readonly source: string;
}): ObserveConsentGrant {
  const fields = options.fields.split(",").map((field) => field.trim());
  if (options.source !== OBSERVE_CONSENT_SOURCE
    || options.pauseControl !== OBSERVE_PAUSE_CONTROL
    || fields.length !== OBSERVE_CONSENT_FIELDS.length
    || !OBSERVE_CONSENT_FIELDS.every((field, index) => fields[index] === field)) {
    throw new Error("Observe consent must use the exact displayed source, fields, and pause control");
  }
  return {
    cadenceMs: parseInteger(options.cadenceMs, "--cadence-ms"),
    fields: fields as ObserveConsentField[],
    pauseControl: OBSERVE_PAUSE_CONTROL,
    retentionDays: parseInteger(options.retentionDays, "--retention-days"),
    source: OBSERVE_CONSENT_SOURCE
  };
}

export function registerObserveCommands(program: Command, io: ProgramIO): void {
  const observe = program.command("observe").description("opt-in, local-only app-category collection for one exact PersonalThread");

  observe.command("consent").description("show the exact Observe consent terms").action(() => {
    write(io, { grantTemplate: OBSERVE_CONSENT_TEMPLATE, terms: OBSERVE_CONSENT_TERMS, version: OBSERVE_CONSENT_VERSION });
  });

  observe.command("start <threadId>")
    .requiredOption("--accept-version <version>", "accept exactly the displayed consent version")
    .requiredOption("--source <source>", "accept the displayed Observe source")
    .requiredOption("--fields <fields>", "accept the displayed comma-separated field list")
    .requiredOption("--cadence-ms <milliseconds>", "choose collection cadence (10000-300000)")
    .requiredOption("--retention-days <days>", "choose retention window (1-365)")
    .requiredOption("--pause-control <command>", "accept the displayed pause control")
    .action(async (threadId: string, options: {
      readonly acceptVersion: string;
      readonly cadenceMs: string;
      readonly fields: string;
      readonly pauseControl: string;
      readonly retentionDays: string;
      readonly source: string;
    }) => {
      try {
        write(io, await startObserveSessionSafe(files(), {
          acceptVersion: parseVersion(options.acceptVersion),
          consent: parseConsent(options),
          threadId
        }));
      }
      catch (cause) { fail(io, cause); }
    });

  observe.command("status").action(async () => {
    try { write(io, await observeStatus(await observeFile())); } catch (cause) { fail(io, cause); }
  });

  observe.command("inspect <sessionId>").action(async (sessionId: string) => {
    try { write(io, await inspectObserveSession(await observeFile(), sessionId)); } catch (cause) { fail(io, cause); }
  });

  observe.command("pause <sessionId>").action(async (sessionId: string) => {
    try { write(io, await pauseObserveSession(await observeFile(), sessionId)); } catch (cause) { fail(io, cause); }
  });

  observe.command("resume <sessionId>").action(async (sessionId: string) => {
    try { write(io, await resumeObserveSessionSafe(files(), sessionId)); } catch (cause) { fail(io, cause); }
  });

  observe.command("forget <sessionId>").description("permanently delete the session and its observations").action(async (sessionId: string) => {
    try { write(io, await forgetObserveSession(await observeFile(), sessionId)); } catch (cause) { fail(io, cause); }
  });
}
