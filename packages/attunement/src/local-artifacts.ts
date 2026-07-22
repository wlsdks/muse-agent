import { promises as fs } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import {
  readRemindersStrict,
  readTaskById,
  readTaskByIdStrict,
  readTasks,
  ReminderStoreUnavailableError,
  type PersistedReminder
} from "@muse/stores";

import { AttunementStoreError } from "./attunement-store.js";

import type { ArtifactLinkValidator } from "./attunement-store.js";
import type { ArtifactLink, ArtifactType, ExactArtifactResolver, ResolvedArtifact } from "./types.js";
import type { ContinuityTaskInteractionSourceResolver } from "./interaction-evidence.js";

export interface LocalArtifactValidatorOptions {
  readonly notesDir: string;
  readonly remindersFile?: string;
  readonly tasksFile: string;
}

type LocalArtifactType = Exclude<ArtifactType, "resource">;

interface LocalContinuityArtifactAdapter {
  readonly artifactType: LocalArtifactType;
  canonicalize(rawId: string): Promise<string>;
  resolve(link: ArtifactLink): Promise<ResolvedArtifact | undefined>;
}

export interface CanonicalLocalNote {
  readonly artifactId: string;
  readonly artifactType: "note";
  readonly providerId: "local";
  readonly summary?: string;
  readonly title: string;
  readonly updatedAt: string;
}

function boundedTaskNotes(notes: string | undefined): string | undefined {
  const normalized = notes?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

function validTaskDueAt(dueAt: string | undefined): string | undefined {
  return dueAt && Number.isFinite(Date.parse(dueAt)) ? dueAt : undefined;
}

function assertNoDotDotPath(value: string): void {
  if (value.split(/[\\/]+/u).some((segment) => segment === "..")) {
    throw new AttunementStoreError("note id must not contain '..'");
  }
}

function containedRelative(root: string, target: string): string | undefined {
  const candidate = relative(root, target);
  if (candidate.length === 0 || candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) return undefined;
  return candidate.split(sep).join("/");
}

/** Exact local-note reader with realpath containment on every call. */
export async function readCanonicalLocalNote(notesDir: string, rawId: string): Promise<CanonicalLocalNote | undefined> {
  const id = rawId.trim();
  if (id.length === 0 || isAbsolute(id)) throw new AttunementStoreError("note id must be a relative vault path");
  assertNoDotDotPath(id);
  let vaultRoot: string;
  let target: string;
  try {
    vaultRoot = await fs.realpath(notesDir);
    target = await fs.realpath(resolve(vaultRoot, id));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  const artifactId = containedRelative(vaultRoot, target);
  if (!artifactId) throw new AttunementStoreError("note path escapes the local notes vault");
  const stat = await fs.stat(target);
  if (stat.isDirectory()) throw new AttunementStoreError("note id points to a directory");
  if (stat.size > 1_048_576) throw new AttunementStoreError("note exceeds the 1 MiB local continuity limit");
  const body = await fs.readFile(target, "utf8");
  const summary = body
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^#+\s*/u, ""))
    .find((line) => line.length > 0);
  return {
    artifactId,
    artifactType: "note",
    providerId: "local",
    ...(summary ? { summary: summary.slice(0, 240) } : {}),
    title: basename(artifactId),
    updatedAt: stat.mtime.toISOString()
  };
}

async function canonicalTaskId(tasksFile: string, raw: string): Promise<string> {
  const id = raw.trim();
  if (id.length === 0) throw new AttunementStoreError("task id must not be empty");
  const tasks = await readTasks(tasksFile);
  if (tasks.some((task) => task.id === id)) return id;
  const matches = tasks.filter((task) => task.id.startsWith(id));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new AttunementStoreError(`no local task with id or unique prefix '${id}'`);
  throw new AttunementStoreError(`task id prefix '${id}' is ambiguous; pass the full id`);
}

function boundedReminderText(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

async function readContinuityReminders(remindersFile: string): Promise<readonly PersistedReminder[]> {
  try {
    return await readRemindersStrict(remindersFile);
  } catch (cause) {
    if (cause instanceof ReminderStoreUnavailableError) {
      throw new AttunementStoreError(cause.message);
    }
    throw cause;
  }
}

async function canonicalReminderId(remindersFile: string, raw: string): Promise<string> {
  const id = raw.trim();
  if (id.length === 0) throw new AttunementStoreError("reminder id must not be empty");
  const reminders = await readContinuityReminders(remindersFile);
  if (reminders.some((reminder) => reminder.id === id)) return id;
  const matches = reminders.filter((reminder) => reminder.id.startsWith(id));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new AttunementStoreError(`no local reminder with id or unique prefix '${id}'`);
  throw new AttunementStoreError(`reminder id prefix '${id}' is ambiguous; pass the full id`);
}

function projectReminder(reminder: PersistedReminder, link: ArtifactLink): ResolvedArtifact | undefined {
  const title = boundedReminderText(reminder.text);
  if (!title || !Number.isFinite(Date.parse(reminder.dueAt))) return undefined;
  return {
    artifactId: reminder.id,
    artifactType: "reminder",
    providerId: "local",
    reminderDueAt: reminder.dueAt,
    reminderStatus: reminder.status,
    role: link.role,
    title
  };
}

function createLocalArtifactAdapters(
  options: LocalArtifactValidatorOptions
): ReadonlyMap<LocalArtifactType, LocalContinuityArtifactAdapter> {
  const adapters: LocalContinuityArtifactAdapter[] = [
    {
      artifactType: "task",
      canonicalize: (rawId) => canonicalTaskId(options.tasksFile, rawId),
      resolve: async (link) => {
        const task = await readTaskById(options.tasksFile, link.artifactId);
        if (!task) return undefined;
        const summary = boundedTaskNotes(task.notes);
        const taskDueAt = validTaskDueAt(task.dueAt);
        return {
          artifactId: task.id,
          artifactType: "task",
          providerId: "local",
          role: link.role,
          ...(summary ? { summary } : {}),
          ...(taskDueAt ? { taskDueAt } : {}),
          taskStatus: task.status,
          ...(task.tags && task.tags.length > 0 ? { taskTags: [...task.tags] } : {}),
          title: task.title,
          updatedAt: task.completedAt ?? task.createdAt
        };
      }
    },
    {
      artifactType: "note",
      canonicalize: async (rawId) => {
        const note = await readCanonicalLocalNote(options.notesDir, rawId);
        if (!note) throw new AttunementStoreError(`no local note with exact id '${rawId}'`);
        return note.artifactId;
      },
      resolve: async (link) => {
        const note = await readCanonicalLocalNote(options.notesDir, link.artifactId);
        return note?.artifactId === link.artifactId ? { ...note, role: link.role } : undefined;
      }
    }
  ];
  const remindersFile = options.remindersFile;
  if (remindersFile) {
    adapters.push({
      artifactType: "reminder",
      canonicalize: (rawId) => canonicalReminderId(remindersFile, rawId),
      resolve: async (link) => {
        const reminders = await readContinuityReminders(remindersFile);
        const reminder = reminders.find((candidate) => candidate.id === link.artifactId);
        return reminder ? projectReminder(reminder, link) : undefined;
      }
    });
  }
  return new Map(adapters.map((adapter) => [adapter.artifactType, adapter]));
}

/** Canonicalizes configured local sources; external resources require their own connected-MCP validator. */
export function createLocalArtifactValidator(options: LocalArtifactValidatorOptions): ArtifactLinkValidator {
  const adapters = createLocalArtifactAdapters(options);
  return async ({ artifactId, artifactType, providerId }) => {
    if (providerId !== "local") throw new AttunementStoreError("local artifact validation requires the local provider");
    const adapter = artifactType === "resource" ? undefined : adapters.get(artifactType);
    if (!adapter) throw new AttunementStoreError(`local artifact validation does not support configured type '${artifactType}'`);
    return { artifactId: await adapter.canonicalize(artifactId), artifactType, providerId };
  };
}

/** Resolve only the already-linked local sources; it never searches or guesses. */
export function createLocalExactArtifactResolver(options: LocalArtifactValidatorOptions): ExactArtifactResolver {
  const adapters = createLocalArtifactAdapters(options);
  return async (link) => {
    if (link.providerId !== "local") return undefined;
    const adapter = link.artifactType === "resource" ? undefined : adapters.get(link.artifactType);
    return adapter?.resolve(link);
  };
}

/** Strict current-source reader for the mutation-free interaction projection. */
export function createLocalContinuityTaskInteractionSourceResolver(
  tasksFile: string
): ContinuityTaskInteractionSourceResolver {
  return async (artifactId) => {
    const task = await readTaskByIdStrict(tasksFile, artifactId);
    if (!task) return undefined;
    return {
      artifactId: task.id,
      createdAt: task.createdAt,
      status: task.status,
      updatedAt: task.completedAt ?? task.createdAt
    };
  };
}
