/**
 * Shared backup-before-discard helper for the versioned on-disk personal
 * stores (`feeds-store.ts`, `episode-index.ts`, `notes-index.ts`). Each
 * store's read path collapses a schema `version` mismatch to an empty /
 * `undefined` default — and because these stores write back on the next
 * mutation, that empty default gets persisted over the original file on
 * the very next write. Without this, a genuine downgrade, on-disk
 * corruption, or a future schema bump this build hasn't shipped yet
 * silently wipes the user's data with zero trace.
 *
 * Call this BEFORE returning the empty default, once a version mismatch
 * is detected. It is deliberately NOT a migration: no `transform()` step,
 * no forward-compat — just "never silently overwrite; always leave a
 * recoverable copy".
 */

import { promises as fs } from "node:fs";

/**
 * Renames the mismatched file to a sibling `<file>.bak-v<found>-<ts>`
 * path so its content survives even though the in-memory read falls back
 * to an empty default. Fail-soft: a rename failure (permissions, the
 * file vanishing from under us) is logged and swallowed — the backup
 * attempt itself must never crash the read path that called it.
 */
export async function backupVersionMismatchedStore(file: string, foundVersion: unknown): Promise<void> {
  const backupPath = `${file}.bak-v${String(foundVersion)}-${Date.now().toString()}`;
  try {
    await fs.rename(file, backupPath);
    console.warn(
      `[recall] ${file}: schema version mismatch (found ${String(foundVersion)}) — preserved prior contents at ${backupPath} before falling back to an empty store`
    );
  } catch (cause) {
    console.warn(
      `[recall] ${file}: schema version mismatch (found ${String(foundVersion)}) — backup to ${backupPath} failed (${cause instanceof Error ? cause.message : String(cause)}); continuing with an empty store, ORIGINAL CONTENT MAY BE LOST on the next write`
    );
  }
}
