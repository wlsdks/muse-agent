/**
 * Suppressed-lessons store (`~/.muse/suppressed-lessons.json`) — the memory
 * behind "undo that TEACHES" (B1 §5). Plain `muse playbook remove` just deletes
 * a learned strategy; the idle distiller would happily re-learn the same lesson
 * the next time the user gives a similar correction. Undo records the strategy
 * text HERE so the distiller can skip re-recording a lesson the user explicitly
 * rejected — and counts how many re-learns it has blocked (the "N suppressed"
 * signal). Same durability posture as the sibling stores: atomic fsync+rename
 * write, tolerant read, corrupt store quarantined aside.
 *
 * This store holds only the rejected TEXT + a block counter — the tight
 * similarity match against an incoming lesson is done at the call site (which
 * has agent-core's `strategyTextSimilarity`); mcp stays free of an agent-core
 * dependency.
 */

import { promises as fs } from "node:fs";

import { isRecord } from "@muse/shared";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

/** Bounds the file + keeps the per-distill scan cheap; newest-kept on overflow. */
export const MAX_SUPPRESSED_LESSONS = 200;

export interface SuppressedLesson {
  readonly id: string;
  readonly userId: string;
  /** The rejected strategy text — shown to the user ("you undid: …"). */
  readonly text: string;
  /**
   * The originating CORRECTION the undone strategy was distilled from (its
   * provenance `source`). This is what the distiller matches an incoming
   * correction against — the stable SIGNAL, not the LLM's paraphrased output
   * (which varies run to run). Absent for pre-provenance / manual entries,
   * which then can't block a re-learn (best-effort).
   */
  readonly source?: string;
  readonly createdAt: string;
  /** How many times this veto has blocked a re-learn (the "N suppressed" count). */
  readonly blockedCount?: number;
}

export async function readSuppressedLessons(file: string): Promise<readonly SuppressedLesson[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorruptStore(file);
    return [];
  }
  const entries = readRecordArrayField(parsed, "entries");
  if (entries === undefined) {
    await quarantineCorruptStore(file);
    return [];
  }
  return entries.flatMap((entry): readonly SuppressedLesson[] =>
    isSuppressedLesson(entry) ? [entry] : []
  );
}

export async function writeSuppressedLessons(file: string, entries: readonly SuppressedLesson[]): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify({ entries }, null, 2)}\n`);
}

export async function querySuppressedLessons(file: string, userId?: string): Promise<readonly SuppressedLesson[]> {
  const all = await readSuppressedLessons(file);
  return userId ? all.filter((e) => e.userId === userId) : all;
}

/** Record (or replace by id) a rejected lesson; caps to MAX_SUPPRESSED_LESSONS (newest kept). */
export async function recordSuppressedLesson(file: string, lesson: SuppressedLesson): Promise<void> {
  await withFileMutationQueue(file, async () => {
    const existing = await readSuppressedLessons(file);
    const next = [...existing.filter((e) => e.id !== lesson.id), lesson].slice(-MAX_SUPPRESSED_LESSONS);
    await writeSuppressedLessons(file, next);
  });
}

/**
 * Bump a suppression's blocked counter (called when it stops a re-learn).
 * Serialised read-modify-write; returns the new count, or undefined if absent.
 */
export async function incrementSuppressionBlocked(file: string, id: string): Promise<number | undefined> {
  return withFileMutationQueue(file, async () => {
    const existing = await readSuppressedLessons(file);
    if (!existing.some((e) => e.id === id)) {
      return undefined;
    }
    let updated = 0;
    const next = existing.map((e) => {
      if (e.id !== id) {
        return e;
      }
      updated = (e.blockedCount ?? 0) + 1;
      return { ...e, blockedCount: updated };
    });
    await writeSuppressedLessons(file, next);
    return updated;
  });
}

function isSuppressedLesson(value: unknown): value is SuppressedLesson {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<SuppressedLesson>;
  if (typeof e.id !== "string" || e.id.length === 0) return false;
  if (typeof e.userId !== "string" || e.userId.length === 0) return false;
  if (typeof e.text !== "string" || e.text.trim().length === 0) return false;
  if (e.source !== undefined && typeof e.source !== "string") return false;
  if (typeof e.createdAt !== "string") return false;
  if (e.blockedCount !== undefined && (typeof e.blockedCount !== "number" || !Number.isFinite(e.blockedCount))) return false;
  return true;
}

function readRecordArrayField(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return Array.isArray(candidate) ? candidate : undefined;
}
