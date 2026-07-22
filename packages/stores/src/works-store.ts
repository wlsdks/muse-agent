/**
 * Pure data layer for "Work" (`~/.muse/works.json`) — docs/design/muse-work.md.
 *
 * A Work is a BINDING, never a new runtime: a one-line goal plus the flows
 * (scheduler jobs), board tasks, and continuity thread that belong to it,
 * plus an outcome history. Deleting a Work severs its references only — the
 * referenced stores (scheduler / board / attunement) own their own lifecycle
 * and are never touched from here.
 *
 * Uses atomic fsync+rename writes, cross-process locks, per-file mutation
 * queues, and a strict bounded read contract. Malformed/future state fails
 * closed without quarantine; writes preserve the encryption format observed
 * by the same locked snapshot.
 *
 * Link ops (`linkWorkFlow` / `linkWorkBoardTask` / `setWorkThread`) take an
 * injected existence-check callback and REFUSE a link to a nonexistent id —
 * the calendar↔reminder lesson (linking two stores means every lifecycle op
 * must stay honest) applies here: a Work must never carry a dangling
 * reference to a flow/task/thread that was never real.
 */

import { randomUUID } from "node:crypto";

import type { JsonObject, JsonValue } from "@muse/shared";

import { withFileLock, withFileMutationQueue } from "./atomic-file-store.js";
import { decryptFileAtRest, encryptFileAtRest, isFileEncryptedAtRest, writeMaybeEncrypted } from "./encrypted-file.js";
import {
  assertValidWorkStoreState,
  EXACT_WORK_CONTENT_MAX_BYTES,
  isCanonicalWorkId,
  readExactWorkCatalog,
  readWorkStoreSnapshot,
  WorkExactReadError
} from "./work-exact-reader.js";

export {
  assertValidWorkStoreState,
  EXACT_WORK_CONTENT_MAX_BYTES,
  EXACT_WORK_PHYSICAL_MAX_BYTES,
  isCanonicalWorkId,
  readExactWork,
  readExactWorkCatalog,
  readWorkStoreSnapshot,
  WorkExactReadError,
  type WorkStoreSnapshot
} from "./work-exact-reader.js";

export type WorkStatus = "active" | "paused" | "done";
export type WorkOutcomeKind = "used" | "adjusted" | "ignored";

const WORK_STATUSES: readonly WorkStatus[] = ["active", "paused", "done"];
const WORK_OUTCOME_KINDS: readonly WorkOutcomeKind[] = ["used", "adjusted", "ignored"];

export interface WorkOutcome {
  readonly atIso: string;
  readonly kind: WorkOutcomeKind;
  readonly note?: string;
}

export interface PersistedWork {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly flowIds: readonly string[];
  readonly boardTaskIds: readonly string[];
  readonly threadId?: string;
  readonly status: WorkStatus;
  readonly outcomes: readonly WorkOutcome[];
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export class WorksStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorksStoreError";
  }
}

/**
 * A link-target existence check, injected by the caller (the scheduler /
 * board / attunement thread store) so this module never depends on any of
 * them directly. Returning `false` REFUSES the link — a Work never carries
 * a best-guess reference to something that doesn't exist.
 */
export type LinkValidator = (id: string) => boolean | Promise<boolean>;

const WORK_ID_PREFIX = "work_";
/**
 * The shortest prefix `resolveWorkId` will accept for a non-exact match —
 * `work_` + 3 characters. Below this bar a fat-fingered near-empty prefix
 * ("w", "work_") would resolve against nearly every Work; this mirrors the
 * personal-tasks CLI's id-prefix convention (`resolveLocalTaskId`) while
 * keeping a floor so a trivial prefix can never accidentally "win".
 */
const MIN_WORK_ID_PREFIX_LENGTH = WORK_ID_PREFIX.length + 3;

/**
 * Resolve a user-supplied Work id: an EXACT id always wins; otherwise a
 * UNIQUE id prefix (at least `MIN_WORK_ID_PREFIX_LENGTH` characters) — so
 * the short id `muse work start` prints (`work_bb5cb…`) round-trips through
 * `show`/`link`/`outcome`/`done`/`delete` without the user ever needing the
 * full uuid. Two or more Works sharing the prefix is AMBIGUOUS and returns
 * `undefined` — never a best guess between them, same posture as every
 * other resolver in this codebase (`resolveTaskRef`, `resolveContact`). Pure.
 */
export function resolveWorkId(works: readonly PersistedWork[], idOrPrefix: string): string | undefined {
  const trimmed = idOrPrefix.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const exact = works.find((work) => work.id === trimmed);
  if (exact) {
    return exact.id;
  }
  if (trimmed.length < MIN_WORK_ID_PREFIX_LENGTH) {
    return undefined;
  }
  const matches = works.filter((work) => work.id.startsWith(trimmed));
  return matches.length === 1 ? matches[0]!.id : undefined;
}

/** The actionable "id not found" message every store op below throws — names the tried id and points at the full-id source of truth. */
function noWorkWithIdError(idOrPrefix: string): WorksStoreError {
  return new WorksStoreError(
    `no work with id '${idOrPrefix}' — run \`muse work list\` to see the full id (muse work list로 전체 id 확인)`
  );
}

export async function readWorks(file: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly PersistedWork[]> {
  return readExactWorkCatalog(file, env);
}

export async function writeWorks(file: string, works: readonly PersistedWork[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await withFileMutationQueue(file, () => withFileLock(file, async () => {
    const snapshot = await readWorkStoreSnapshot(file, env);
    await writeWorkStoreStateUnlocked(file, works, snapshot.encrypted, env);
  }));
}

/** Caller must already hold the Work file lock. */
export async function writeWorkStoreStateUnlocked(
  file: string,
  works: readonly PersistedWork[],
  encrypted: boolean,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const text = `${JSON.stringify({ version: 1, works }, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > EXACT_WORK_CONTENT_MAX_BYTES) {
    throw new WorkExactReadError("Work store plaintext exceeds the size limit");
  }
  assertValidWorkStoreState(works);
  await writeMaybeEncrypted(file, text, encrypted, env);
}

/**
 * Serialized read-modify-write under the cross-process lock + per-file
 * mutation queue, so a concurrent CLI write and API write can't clobber
 * each other. Every mutating op in this module goes through it. Mirrors
 * `mutateTasks` / `mutateContacts`.
 */
export async function mutateWorks(
  file: string,
  fn: (current: readonly PersistedWork[]) => readonly PersistedWork[] | Promise<readonly PersistedWork[]>,
  env: NodeJS.ProcessEnv = process.env
): Promise<readonly PersistedWork[]> {
  return withFileMutationQueue(file, () => withFileLock(file, async () => {
    const snapshot = await readWorkStoreSnapshot(file, env);
    const current = snapshot.works;
    const next = await fn(current);
    if (next !== current) {
      await writeWorkStoreStateUnlocked(file, next, snapshot.encrypted, env);
    }
    return next;
  }));
}

/** Most-recently-touched Work first — the "what am I in the middle of" view. */
export async function listWorks(file: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly PersistedWork[]> {
  const all = await readWorks(file, env);
  return [...all].sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso) || a.id.localeCompare(b.id));
}

/** Accepts an exact id OR a unique id prefix (`resolveWorkId`) — a miss/ambiguous prefix returns `undefined`, same as an unknown id. */
export async function getWork(file: string, id: string, env: NodeJS.ProcessEnv = process.env): Promise<PersistedWork | undefined> {
  const works = await readWorks(file, env);
  const resolvedId = resolveWorkId(works, id);
  return resolvedId ? works.find((work) => work.id === resolvedId) : undefined;
}

export interface CreateWorkInput {
  readonly name: string;
  readonly goal: string;
}

export async function createWork(
  file: string,
  input: CreateWorkInput,
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly idFactory?: () => string; readonly now?: () => Date } = {}
): Promise<PersistedWork> {
  const name = input.name.trim();
  const goal = input.goal.trim();
  if (name.length === 0) {
    throw new WorksStoreError("work name must be a non-empty string");
  }
  if (goal.length === 0) {
    throw new WorksStoreError("work goal must be a non-empty string");
  }
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const work: PersistedWork = {
    boardTaskIds: [],
    createdAtIso: nowIso,
    flowIds: [],
    goal,
    id: options.idFactory ? options.idFactory() : `work_${randomUUID()}`,
    name,
    outcomes: [],
    status: "active",
    updatedAtIso: nowIso
  };
  if (!isCanonicalWorkId(work.id)) throw new WorksStoreError("id factory returned a non-canonical Work id");
  await mutateWorks(file, (current) => [...current, work], env);
  return work;
}

/**
 * Apply `transform` to the Work identified by `workId` (an exact id OR a
 * unique prefix, `resolveWorkId`) and persist it, touching `updatedAtIso`.
 * Throws (BEFORE any write, inside the lock) when the id/prefix doesn't
 * resolve — every op below composes on this so an unknown-id failure never
 * leaves a partial write.
 */
async function mutateWorkById(
  file: string,
  workId: string,
  transform: (work: PersistedWork) => PersistedWork,
  env: NodeJS.ProcessEnv,
  now: () => Date = () => new Date()
): Promise<PersistedWork> {
  let result: PersistedWork | undefined;
  await mutateWorks(file, (current) => {
    const resolvedId = resolveWorkId(current, workId);
    if (!resolvedId) {
      throw noWorkWithIdError(workId);
    }
    const index = current.findIndex((work) => work.id === resolvedId);
    const updated: PersistedWork = { ...transform(current[index]!), updatedAtIso: now().toISOString() };
    result = updated;
    const next = [...current];
    next[index] = updated;
    return next;
  }, env);
  return result!;
}

export interface UpdateWorkInput {
  readonly name?: string;
  readonly status?: WorkStatus;
}

/** Rename and/or change status — the only two fields a Work update touches. */
export async function updateWork(
  file: string,
  workId: string,
  patch: UpdateWorkInput,
  env: NodeJS.ProcessEnv = process.env
): Promise<PersistedWork> {
  const name = patch.name?.trim();
  if (name !== undefined && name.length === 0) {
    throw new WorksStoreError("work name must be a non-empty string");
  }
  if (patch.status !== undefined && !WORK_STATUSES.includes(patch.status)) {
    throw new WorksStoreError(`status must be one of ${WORK_STATUSES.join(", ")} (got '${String(patch.status)}')`);
  }
  return mutateWorkById(file, workId, (work) => ({
    ...work,
    ...(name ? { name } : {}),
    ...(patch.status ? { status: patch.status } : {})
  }), env);
}

export async function linkWorkFlow(
  file: string,
  workId: string,
  flowId: string,
  flowExists: LinkValidator,
  env: NodeJS.ProcessEnv = process.env
): Promise<PersistedWork> {
  if (!(await flowExists(flowId))) {
    throw new WorksStoreError(`no flow (scheduler job) with id '${flowId}' — refusing to link a nonexistent flow to work '${workId}'`);
  }
  return mutateWorkById(file, workId, (work) => ({
    ...work,
    flowIds: work.flowIds.includes(flowId) ? work.flowIds : [...work.flowIds, flowId]
  }), env);
}

/** Idempotent — unlinking a flow that isn't there is a no-op, not an error. */
export async function unlinkWorkFlow(
  file: string,
  workId: string,
  flowId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<PersistedWork> {
  return mutateWorkById(file, workId, (work) => ({
    ...work,
    flowIds: work.flowIds.filter((id) => id !== flowId)
  }), env);
}

export async function linkWorkBoardTask(
  file: string,
  workId: string,
  taskId: string,
  boardTaskExists: LinkValidator,
  env: NodeJS.ProcessEnv = process.env
): Promise<PersistedWork> {
  if (!(await boardTaskExists(taskId))) {
    throw new WorksStoreError(`no board task with id '${taskId}' — refusing to link a nonexistent task to work '${workId}'`);
  }
  return mutateWorkById(file, workId, (work) => ({
    ...work,
    boardTaskIds: work.boardTaskIds.includes(taskId) ? work.boardTaskIds : [...work.boardTaskIds, taskId]
  }), env);
}

/** Idempotent — unlinking a task that isn't there is a no-op, not an error. */
export async function unlinkWorkBoardTask(
  file: string,
  workId: string,
  taskId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<PersistedWork> {
  return mutateWorkById(file, workId, (work) => ({
    ...work,
    boardTaskIds: work.boardTaskIds.filter((id) => id !== taskId)
  }), env);
}

export async function setWorkThread(
  file: string,
  workId: string,
  threadId: string,
  threadExists: LinkValidator,
  env: NodeJS.ProcessEnv = process.env
): Promise<PersistedWork> {
  if (!(await threadExists(threadId))) {
    throw new WorksStoreError(`no continuity thread with id '${threadId}' — refusing to link a nonexistent thread to work '${workId}'`);
  }
  return mutateWorkById(file, workId, (work) => ({ ...work, threadId }), env);
}

/** Idempotent — clearing an already-unset thread is a no-op, not an error. */
export async function unlinkWorkThread(
  file: string,
  workId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<PersistedWork> {
  return mutateWorkById(file, workId, (work) => {
    const { threadId: _threadId, ...rest } = work;
    return rest;
  }, env);
}

export interface AddWorkOutcomeInput {
  readonly kind: WorkOutcomeKind;
  readonly note?: string;
}

/**
 * Record an outcome (`used`/`adjusted`/`ignored`), the same vocabulary the
 * continuity-thread outcome uses (docs/design/muse-work.md) — "done" is
 * judged from this history, never from a model's self-report.
 */
export async function addWorkOutcome(
  file: string,
  workId: string,
  input: AddWorkOutcomeInput,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date()
): Promise<PersistedWork> {
  if (!WORK_OUTCOME_KINDS.includes(input.kind)) {
    throw new WorksStoreError(`outcome kind must be one of ${WORK_OUTCOME_KINDS.join(", ")} (got '${String(input.kind)}')`);
  }
  const note = input.note?.trim();
  const outcome: WorkOutcome = {
    atIso: now().toISOString(),
    kind: input.kind,
    ...(note && note.length > 0 ? { note } : {})
  };
  return mutateWorkById(file, workId, (work) => ({ ...work, outcomes: [...work.outcomes, outcome] }), env, now);
}

export async function markWorkDone(file: string, workId: string, env: NodeJS.ProcessEnv = process.env): Promise<PersistedWork> {
  return mutateWorkById(file, workId, (work) => ({ ...work, status: "done" }), env);
}

/**
 * Severs the Work entry only — the referenced flows/tasks/thread are never
 * touched. Accepts an exact id OR a unique id prefix (`resolveWorkId`); a
 * miss/ambiguous prefix is reported as `false` (not found), same as an
 * unknown id — deletion stays idempotent, never throws.
 */
export async function deleteWork(file: string, workId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  let removed = false;
  await mutateWorks(file, (current) => {
    const resolvedId = resolveWorkId(current, workId);
    if (!resolvedId) {
      return current;
    }
    const next = current.filter((work) => work.id !== resolvedId);
    removed = next.length !== current.length;
    return next;
  }, env);
  return removed;
}

/**
 * Lifecycle-audit sweep (the calendar↔reminder lesson: linking two stores
 * means every lifecycle op must stay honest). Drops a Work's `flowIds` that
 * are no longer in `existingFlowIds` (the scheduler's current job list).
 * Returns the SAME `works` reference when nothing changes, so a caller can
 * skip the write entirely. Pure.
 */
export function pruneDeletedFlowRefs(
  works: readonly PersistedWork[],
  existingFlowIds: readonly string[]
): readonly PersistedWork[] {
  const existing = new Set(existingFlowIds);
  let changed = false;
  const next = works.map((work) => {
    if (work.flowIds.every((id) => existing.has(id))) {
      return work;
    }
    changed = true;
    return { ...work, flowIds: work.flowIds.filter((id) => existing.has(id)) };
  });
  return changed ? next : works;
}

/**
 * Applied delete-sync: best-effort read→prune→write, fail-open. A works-store
 * hiccup (missing file, bad permissions, wrong encryption key) must NEVER
 * block the real scheduler job delete it's reacting to. Returns the number
 * of Works actually pruned (0 on any failure or when nothing referenced the
 * deleted job).
 */
export async function syncWorksOnFlowDelete(
  worksFile: string,
  existingFlowIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  try {
    let prunedCount = 0;
    await mutateWorks(worksFile, (current) => {
      const next = pruneDeletedFlowRefs(current, existingFlowIds);
      if (next !== current) {
        prunedCount = next.filter((work, index) => work !== current[index]).length;
      }
      return next;
    }, env);
    return prunedCount;
  } catch {
    return 0;
  }
}

export function serializeWork(work: PersistedWork): JsonObject {
  return {
    boardTaskIds: [...work.boardTaskIds] as JsonValue,
    createdAtIso: work.createdAtIso,
    flowIds: [...work.flowIds] as JsonValue,
    goal: work.goal,
    id: work.id,
    name: work.name,
    outcomes: work.outcomes.map((outcome) => ({
      atIso: outcome.atIso,
      kind: outcome.kind,
      ...(outcome.note ? { note: outcome.note } : {})
    })) as JsonValue,
    status: work.status,
    ...(work.threadId ? { threadId: work.threadId } : {}),
    updatedAtIso: work.updatedAtIso
  };
}

/**
 * Canonical empty body — seeded when encrypting an absent/empty store so the
 * encrypted format is ESTABLISHED on disk (else the first later write would
 * peek "no file", land in plaintext, and drop the encrypt intent).
 */
const EMPTY_WORKS_BODY = `${JSON.stringify({ works: [] }, null, 2)}\n`;

/** One-shot migrate works.json to encryption-at-rest. Same envelope as memory/episodes/contacts. */
export async function encryptWorksAtRest(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly alreadyEncrypted: boolean; readonly backupPath?: string }> {
  return encryptFileAtRest(file, env, { emptyContent: EMPTY_WORKS_BODY });
}

/** Reverse the migration — rewrite plaintext. Throws fail-closed on a wrong key. */
export async function decryptWorksAtRest(file: string, env: NodeJS.ProcessEnv = process.env): Promise<{ readonly alreadyPlaintext: boolean }> {
  return decryptFileAtRest(file, env);
}

/** Format-only check (no key needed). */
export async function isWorksEncrypted(file: string): Promise<boolean> {
  return isFileEncryptedAtRest(file);
}
