/**
 * `muse rollback` — undo an agent file write. Every file_write / file_edit /
 * file_multi_edit / file_delete / file_move snapshots the target's state
 * BEFORE mutating it (`@muse/fs`'s `FileCheckpointStore`, wired in
 * `ask-tool-wiring.ts`); this command lists those snapshots and restores one.
 *
 *   - `muse rollback` / `muse rollback list`        — newest-first table
 *   - `muse rollback <id|prefix|last> --yes`         — restore it
 *
 * `id|prefix` resolution mirrors `muse chats`'s fail-close rule: an exact id
 * always wins, an unambiguous prefix resolves, an ambiguous prefix refuses
 * (lists every candidate) rather than acting on a guess. Restoring is
 * destructive to the CURRENT file, so — mirroring `muse chats delete
 * --yes` — it requires `--yes`; without it, nothing is touched. Right
 * before the actual restore, the CURRENT state at the target path is ITSELF
 * checkpointed ("pre-rollback of <id>") so a rollback is always undoable too.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Command } from "commander";
import { CURRENT_CHECKPOINT_VERSION, defaultCheckpointsDir, FileCheckpointStore, type CheckpointManifest } from "@muse/fs";

import { formatRelativeTime } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

export type CheckpointRefResolution =
  | { readonly status: "resolved"; readonly manifest: CheckpointManifest }
  | { readonly status: "ambiguous"; readonly candidates: readonly CheckpointManifest[] }
  | { readonly status: "not-found" };

/**
 * Resolve a user-supplied id, unambiguous id-prefix, or the literal `last`
 * against a NEWEST-FIRST manifest list. Mirrors `resolveConversationRef`
 * (`@muse/stores`) — exact id wins, multiple prefix matches are AMBIGUOUS
 * (fail-close, return every candidate) rather than acting on a guess.
 */
export function resolveCheckpointRef(manifests: readonly CheckpointManifest[], ref: string): CheckpointRefResolution {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return { status: "not-found" };
  }
  if (trimmed === "last") {
    return manifests.length > 0 ? { manifest: manifests[0]!, status: "resolved" } : { status: "not-found" };
  }
  const exact = manifests.find((m) => m.id === trimmed);
  if (exact) {
    return { status: "resolved", manifest: exact };
  }
  const matches = manifests.filter((m) => m.id.startsWith(trimmed));
  if (matches.length === 1) {
    return { manifest: matches[0]!, status: "resolved" };
  }
  if (matches.length > 1) {
    return { candidates: matches, status: "ambiguous" };
  }
  return { status: "not-found" };
}

/** Pretty-print the checkpoint list (pure; exported for tests). */
export function formatCheckpointList(manifests: readonly CheckpointManifest[], now: Date = new Date()): string {
  if (manifests.length === 0) {
    return "No checkpoints yet — every agent file write is snapshotted the first time it happens.\n";
  }
  // A checkpoint written by a NEWER Muse (version > this build's ceiling)
  // is skipped from the itemized rows — nothing here can render or restore
  // it — and folded into one fail-soft warning line instead of silently
  // vanishing (still id-addressable: `resolveCheckpointRef` sees the full
  // list, so `muse rollback <id>` on it hits the fail-closed restore refusal).
  const displayable = manifests.filter((m) => m.version <= CURRENT_CHECKPOINT_VERSION);
  const skipped = manifests.length - displayable.length;
  if (displayable.length === 0) {
    return `⚠ ${skipped.toString()} checkpoint(s) skipped — written by a newer version of Muse (checkpoint format newer than v${CURRENT_CHECKPOINT_VERSION.toString()}). Upgrade Muse to view/restore them.\n`;
  }
  const lines = displayable.map((m, index) => {
    const truncatedNote = m.truncated ? " [too large to restore]" : "";
    return `${(index + 1).toString()}. [${m.id}] ${m.action} ${m.path} — ${m.summary}${truncatedNote}, ${formatRelativeTime(m.at, now)}`;
  });
  const warning = skipped > 0
    ? `\n⚠ ${skipped.toString()} checkpoint(s) skipped — written by a newer version of Muse (checkpoint format newer than v${CURRENT_CHECKPOINT_VERSION.toString()}). Upgrade Muse to view/restore them.`
    : "";
  return `${lines.join("\n")}${warning}\n`;
}

/**
 * The CURRENT bytes at `path`, or `undefined` if nothing is there. NEVER
 * decoded through `"utf8"` — a binary file (a JPEG, anything with an
 * invalid-UTF-8 byte sequence) must checkpoint and restore byte-exact, and a
 * text encoding here would silently corrupt it before it ever reaches disk.
 */
async function readCurrentContent(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function registerRollbackCommand(program: Command, io: ProgramIO): void {
  program
    .command("rollback")
    .description("Undo an agent file write (file_write/file_edit/file_multi_edit/file_delete/file_move), or list undoable checkpoints")
    .argument("[id]", "Checkpoint id, unambiguous prefix, or `last` — omit (or pass `list`) to list checkpoints")
    .option("--yes", "Confirm the restore (this overwrites/deletes/moves the CURRENT file). Without it, nothing is touched.")
    .option("--json", "Print the raw payload instead of the formatted output")
    .action(async (id: string | undefined, options: { readonly yes?: boolean; readonly json?: boolean }) => {
      const store = new FileCheckpointStore({ dir: defaultCheckpointsDir(process.env) });

      if (!id || id === "list") {
        const manifests = await store.list();
        if (options.json) {
          io.stdout(`${JSON.stringify({ checkpoints: manifests, total: manifests.length }, null, 2)}\n`);
          return;
        }
        io.stdout(formatCheckpointList(manifests));
        return;
      }

      const manifests = await store.list();
      const resolution = resolveCheckpointRef(manifests, id);
      if (resolution.status === "not-found") {
        throw new Error(`No checkpoint found with id "${id}". Run 'muse rollback list' to see them.`);
      }
      if (resolution.status === "ambiguous") {
        const previews = resolution.candidates.map((c) => `${c.id} (${c.action} ${c.path})`).join(", ");
        throw new Error(`Ambiguous checkpoint id "${id}" — matches ${resolution.candidates.length.toString()}: ${previews}`);
      }
      const manifest = resolution.manifest;
      if (manifest.version > CURRENT_CHECKPOINT_VERSION) {
        throw new Error(`Checkpoint [${manifest.id}] was written by a newer version of Muse (checkpoint format v${manifest.version.toString()}; this Muse supports up to v${CURRENT_CHECKPOINT_VERSION.toString()}) — refusing to restore it. Upgrade Muse and try again.`);
      }
      if (manifest.truncated) {
        throw new Error(`Checkpoint [${manifest.id}] for '${manifest.path}' was too large to snapshot (over the per-file cap) — rollback is not possible for it.`);
      }

      const preview = manifest.action === "move"
        ? `move ${manifest.path} back to ${manifest.fromPath ?? "?"}`
        : manifest.existedBefore
          ? `restore ${manifest.path} to its content from ${formatRelativeTime(manifest.at)}`
          : `delete ${manifest.path} (it did not exist before that ${manifest.action})`;

      if (!options.yes) {
        io.stdout(`Would ${preview} — checkpoint [${manifest.id}], ${manifest.summary}, ${formatRelativeTime(manifest.at)}.\n`);
        io.stdout("Pass --yes to confirm. The CURRENT file (if any) is checkpointed first, so this is itself undoable.\n");
        return;
      }

      // Undo-of-undo: checkpoint whatever is CURRENTLY at the target path before
      // touching it — a rollback is never itself a dead end.
      const currentContent = await readCurrentContent(manifest.path);
      await store.record({ action: manifest.action, originalContent: currentContent, path: manifest.path, summary: `pre-rollback of ${manifest.id}` });

      if (manifest.action === "move") {
        if (!manifest.fromPath) {
          throw new Error(`Checkpoint [${manifest.id}] is a move with no recorded source — can't roll it back.`);
        }
        const stillAtTarget = await readCurrentContent(manifest.path);
        if (stillAtTarget === undefined) {
          throw new Error(`Nothing is currently at '${manifest.path}' — the moved file may already have been moved/deleted again. Nothing was touched (the current state was still checkpointed).`);
        }
        const sourceOccupied = (await readCurrentContent(manifest.fromPath)) !== undefined;
        if (sourceOccupied) {
          throw new Error(`'${manifest.fromPath}' already has a different file at it now — refusing to overwrite. Nothing was touched (the current state was still checkpointed).`);
        }
        await mkdir(dirname(manifest.fromPath), { recursive: true });
        await rename(manifest.path, manifest.fromPath);
        io.stdout(`Moved ${manifest.path} back to ${manifest.fromPath}.\n`);
        return;
      }

      if (manifest.existedBefore) {
        const record = await store.get(manifest.id);
        if (record?.content === undefined) {
          throw new Error(`Checkpoint [${manifest.id}]'s content is missing on disk — can't restore it.`);
        }
        await mkdir(dirname(manifest.path), { recursive: true });
        // NO encoding — write the RAW bytes back exactly as snapshotted.
        await writeFile(manifest.path, record.content);
        io.stdout(`Restored ${manifest.path} to its content from ${formatRelativeTime(manifest.at)}.\n`);
        return;
      }

      // existedBefore:false — the checkpointed action CREATED the file, so undo removes it.
      await rm(manifest.path, { force: true });
      io.stdout(`Deleted ${manifest.path} (rolled back the ${manifest.action} that created it).\n`);
    });
}
