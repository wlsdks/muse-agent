import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { errorMessage, isRecord, parseJson } from "@muse/shared";
import { atomicWriteFile, readTaskByIdStrict } from "@muse/stores";

import { recordContinuityTaskCompletionInteraction } from "./attunement-store.js";
import { mutateFileState, type FileStateMutation } from "./file-state-mutation.js";

export const CONTINUITY_INTERACTION_OUTBOX_MAX_PENDING = 256;
export const CONTINUITY_INTERACTION_OUTBOX_RETRY_BATCH = 64;

export interface ContinuityInteractionOutboxEvent {
  readonly attempts: number;
  readonly completedAt: string;
  readonly eventId: string;
  readonly lastAttemptAt?: string;
  readonly lastError?: string;
  readonly preparedAt: string;
  readonly taskId: string;
}

export interface ContinuityInteractionOutboxState {
  readonly entries: readonly ContinuityInteractionOutboxEvent[];
  readonly schemaVersion: 1;
}

export interface PrepareContinuityTaskCompletionInput {
  readonly completedAt: string;
  readonly taskId: string;
}

export interface ContinuityInteractionOutboxOptions {
  readonly now?: () => Date;
}

export interface RetryContinuityInteractionOutboxOptions extends ContinuityInteractionOutboxOptions {
  readonly batchSize?: number;
}

export interface RetryContinuityInteractionOutboxSummary {
  readonly attempted: number;
  readonly errors: readonly { readonly eventId: string; readonly message: string }[];
  readonly recorded: number;
  readonly retained: number;
  readonly terminal: number;
}

export class ContinuityInteractionOutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuityInteractionOutboxError";
  }
}

const EMPTY_STATE: ContinuityInteractionOutboxState = { entries: [], schemaVersion: 1 };

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNodeErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

function isEvent(value: unknown): value is ContinuityInteractionOutboxEvent {
  return isRecord(value)
    && Number.isSafeInteger(value.attempts)
    && typeof value.attempts === "number"
    && value.attempts >= 0
    && isIsoTimestamp(value.completedAt)
    && typeof value.eventId === "string"
    && (value.lastAttemptAt === undefined || isIsoTimestamp(value.lastAttemptAt))
    && (value.lastError === undefined || (typeof value.lastError === "string" && value.lastError.length <= 1_000))
    && isIsoTimestamp(value.preparedAt)
    && typeof value.taskId === "string"
    && value.taskId.trim().length > 0
    && value.eventId === eventId(value.taskId, value.completedAt);
}

function parseState(value: unknown): ContinuityInteractionOutboxState {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.entries)
    || value.entries.length > CONTINUITY_INTERACTION_OUTBOX_MAX_PENDING
    || !value.entries.every(isEvent)) {
    throw new ContinuityInteractionOutboxError("continuity interaction outbox is invalid; refusing to overwrite it");
  }
  const entries = value.entries as unknown as readonly ContinuityInteractionOutboxEvent[];
  if (new Set(entries.map((entry) => entry.eventId)).size !== entries.length) {
    throw new ContinuityInteractionOutboxError("continuity interaction outbox has duplicate event ids");
  }
  return { entries, schemaVersion: 1 };
}

function eventId(taskId: string, completedAt: string): string {
  return `continuity_interaction_pending_${createHash("sha256")
    .update(`${taskId}\u0000${completedAt}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function nowIso(options: ContinuityInteractionOutboxOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}

export function resolveContinuityInteractionOutboxFile(attunementFile: string): string {
  const extension = extname(attunementFile);
  const stem = basename(attunementFile, extension);
  return join(dirname(attunementFile), `${stem}.interaction-outbox.json`);
}

export async function readContinuityInteractionOutbox(
  attunementFile: string
): Promise<ContinuityInteractionOutboxState> {
  const file = resolveContinuityInteractionOutboxFile(attunementFile);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return EMPTY_STATE;
    throw cause;
  }
  const parsed = parseJson(raw);
  if (parsed === undefined) {
    throw new ContinuityInteractionOutboxError("continuity interaction outbox is not valid JSON; refusing to overwrite it");
  }
  return parseState(parsed);
}

async function writeState(attunementFile: string, state: ContinuityInteractionOutboxState): Promise<void> {
  const parsed = parseState(state);
  await atomicWriteFile(
    resolveContinuityInteractionOutboxFile(attunementFile),
    `${JSON.stringify(parsed, null, 2)}\n`
  );
}

async function mutate<Result>(
  attunementFile: string,
  fn: (state: ContinuityInteractionOutboxState) => FileStateMutation<ContinuityInteractionOutboxState, Result>
): Promise<Result> {
  const file = resolveContinuityInteractionOutboxFile(attunementFile);
  return mutateFileState(
    file,
    () => readContinuityInteractionOutbox(attunementFile),
    (_file, state) => writeState(attunementFile, state),
    fn
  );
}

export async function prepareContinuityTaskCompletionInteraction(
  attunementFile: string,
  input: PrepareContinuityTaskCompletionInput,
  options: ContinuityInteractionOutboxOptions = {}
): Promise<ContinuityInteractionOutboxEvent> {
  if (input.taskId.trim().length === 0 || !isIsoTimestamp(input.completedAt)) {
    throw new ContinuityInteractionOutboxError("continuity interaction outbox requires an exact task id and completedAt");
  }
  const pending: ContinuityInteractionOutboxEvent = {
    attempts: 0,
    completedAt: input.completedAt,
    eventId: eventId(input.taskId, input.completedAt),
    preparedAt: nowIso(options),
    taskId: input.taskId
  };
  return mutate(attunementFile, (state) => {
    const replay = state.entries.find((entry) => entry.eventId === pending.eventId);
    if (replay) {
      if (replay.taskId !== pending.taskId || replay.completedAt !== pending.completedAt) {
        throw new ContinuityInteractionOutboxError("continuity interaction outbox event id conflict");
      }
      return { changed: false, result: replay, state };
    }
    if (state.entries.length >= CONTINUITY_INTERACTION_OUTBOX_MAX_PENDING) {
      throw new ContinuityInteractionOutboxError("continuity interaction outbox is full; refusing to drop pending evidence");
    }
    return {
      changed: true,
      result: pending,
      state: { entries: [...state.entries, pending], schemaVersion: 1 }
    };
  });
}

type AttemptResult =
  | { readonly kind: "pending"; readonly error?: string }
  | { readonly kind: "terminal"; readonly recorded: boolean };

async function attemptEvent(
  attunementFile: string,
  tasksFile: string,
  event: ContinuityInteractionOutboxEvent
): Promise<AttemptResult> {
  let task: Awaited<ReturnType<typeof readTaskByIdStrict>>;
  try {
    task = await readTaskByIdStrict(tasksFile, event.taskId);
  } catch (cause) {
    return { error: errorMessage(cause), kind: "pending" };
  }
  if (!task) return { kind: "terminal", recorded: false };
  if (task.status === "open") return { kind: "pending" };
  if (task.completedAt !== event.completedAt) return { kind: "terminal", recorded: false };
  try {
    const result = await recordContinuityTaskCompletionInteraction(attunementFile, tasksFile, event.taskId);
    if (result.kind === "unavailable") return { error: "continuity interaction source is unavailable", kind: "pending" };
    return { kind: "terminal", recorded: result.kind === "recorded" };
  } catch (cause) {
    return { error: errorMessage(cause), kind: "pending" };
  }
}

export async function retryContinuityTaskCompletionInteractions(
  attunementFile: string,
  tasksFile: string,
  options: RetryContinuityInteractionOutboxOptions = {}
): Promise<RetryContinuityInteractionOutboxSummary> {
  const requestedBatchSize = options.batchSize ?? CONTINUITY_INTERACTION_OUTBOX_RETRY_BATCH;
  const batchSize = Math.max(1, Math.min(
    CONTINUITY_INTERACTION_OUTBOX_RETRY_BATCH,
    Number.isFinite(requestedBatchSize)
      ? Math.trunc(requestedBatchSize)
      : CONTINUITY_INTERACTION_OUTBOX_RETRY_BATCH
  ));
  const snapshot = (await readContinuityInteractionOutbox(attunementFile)).entries.slice(0, batchSize);
  let recorded = 0;
  let terminal = 0;
  const errors: { eventId: string; message: string }[] = [];
  for (const event of snapshot) {
    const result = await attemptEvent(attunementFile, tasksFile, event);
    const attemptedAt = nowIso(options);
    await mutate(attunementFile, (state) => {
      const current = state.entries.find((entry) => entry.eventId === event.eventId);
      if (!current) return { changed: false, result: undefined, state };
      if (result.kind === "terminal") {
        return {
          changed: true,
          result: undefined,
          state: { entries: state.entries.filter((entry) => entry.eventId !== event.eventId), schemaVersion: 1 }
        };
      }
      const updated: ContinuityInteractionOutboxEvent = {
        ...current,
        attempts: Math.min(Number.MAX_SAFE_INTEGER, current.attempts + 1),
        lastAttemptAt: attemptedAt,
        ...(result.error ? { lastError: result.error } : { lastError: undefined })
      };
      return {
        changed: true,
        result: undefined,
        state: {
          entries: state.entries.map((entry) => entry.eventId === event.eventId ? updated : entry),
          schemaVersion: 1
        }
      };
    });
    if (result.kind === "terminal") {
      terminal += 1;
      if (result.recorded) recorded += 1;
    } else if (result.error) {
      errors.push({ eventId: event.eventId, message: result.error });
    }
  }
  return {
    attempted: snapshot.length,
    errors,
    recorded,
    retained: (await readContinuityInteractionOutbox(attunementFile)).entries.length,
    terminal
  };
}
