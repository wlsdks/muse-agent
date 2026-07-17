import { promises as fs } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { readTaskById, readTasks } from "@muse/stores";

import { AttunementStoreError } from "./attunement-store.js";

import type { ArtifactLinkValidator } from "./attunement-store.js";
import type { ExactArtifactResolver } from "./types.js";

export interface LocalArtifactValidatorOptions {
  readonly notesDir: string;
  readonly tasksFile: string;
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

/** Canonicalizes only local task/note links; external resources require their own connected-MCP validator. */
export function createLocalArtifactValidator(options: LocalArtifactValidatorOptions): ArtifactLinkValidator {
  return async ({ artifactId, artifactType, providerId }) => {
    if (providerId !== "local") throw new AttunementStoreError("local artifact validation requires the local provider");
    if (artifactType === "task") return { artifactId: await canonicalTaskId(options.tasksFile, artifactId), artifactType, providerId };
    if (artifactType === "note") {
      const note = await readCanonicalLocalNote(options.notesDir, artifactId);
      if (!note) throw new AttunementStoreError(`no local note with exact id '${artifactId}'`);
      return { artifactId: note.artifactId, artifactType, providerId };
    }
    throw new AttunementStoreError("local artifact validation supports task and note only");
  };
}

/** Resolve only the already-linked local sources; it never searches or guesses. */
export function createLocalExactArtifactResolver(options: LocalArtifactValidatorOptions): ExactArtifactResolver {
  return async (link) => {
    if (link.providerId !== "local") return undefined;
    if (link.artifactType === "task") {
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
    if (link.artifactType === "note") {
      const note = await readCanonicalLocalNote(options.notesDir, link.artifactId);
      return note?.artifactId === link.artifactId ? { ...note, role: link.role } : undefined;
    }
    return undefined;
  };
}
