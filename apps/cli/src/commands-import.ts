/**
 * `muse import <tar> [--dry-run] [--force]` — restore a backup
 * produced by `muse export` into `~/.muse/`.
 *
 * Refuses to overwrite an existing file unless `--force`
 * is set. `--dry-run` prints the plan without touching disk.
 *
 * Shells out to system `tar` (same dep posture as
 * `commands-export.ts`). Reads the manifest via `tar -tzf` first,
 * runs the collision check, then either reports the plan or
 * extracts with `tar -xzf`.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";



import type { Command } from "commander";

import { decryptExportBuffer, isEncryptedExportBuffer } from "./export-crypto.js";
import { commandErrorLine } from "./format-cli-error.js";
import type { ProgramIO } from "./program.js";
import { withBestEffort } from "./async-promises.js";

const MUSE_PREFIX = ".muse/";

function museEntryRelative(entry: string): string {
  return entry.startsWith(MUSE_PREFIX) ? entry.slice(MUSE_PREFIX.length) : entry;
}

interface ImportOptions {
  readonly force?: boolean;
  readonly dryRun?: boolean;
  /**
   * Explicit decrypt mode. Even without the flag the
   * importer auto-detects an encrypted bundle by reading the
   * magic header, so the flag is opt-in only for the case where
   * the operator wants the prompt forced (e.g. a CI passphrase
   * env should be present but the operator wants to verify).
   */
  readonly decrypt?: boolean;
}

/**
 * When the importer detects an encrypted bundle (or
 * `--decrypt` is set), decrypt the bytes to a temp file and
 * return that path so the rest of the pipeline keeps working
 * unchanged. Caller is responsible for unlinking the temp.
 */
async function decryptToTempIfNeeded(bundlePath: string, decryptOptIn: boolean): Promise<{ readonly path: string; readonly tempPath: string | undefined }> {
  const bytes = await readFile(bundlePath);
  if (!isEncryptedExportBuffer(bytes) && !decryptOptIn) {
    return { path: bundlePath, tempPath: undefined };
  }
  if (!isEncryptedExportBuffer(bytes) && decryptOptIn) {
    throw new Error("--decrypt set but the bundle has no MUSE encrypted-header magic");
  }
  const passphrase = process.env.MUSE_EXPORT_PASSPHRASE?.trim();
  let key: string;
  if (passphrase && passphrase.length > 0) {
    key = passphrase;
  } else {
    const { password } = await import("@clack/prompts");
    const answer = await password({ message: "Decrypt passphrase:" });
    if (typeof answer !== "string" || answer.trim().length === 0) {
      throw new Error("import aborted: passphrase is required for an encrypted bundle");
    }
    key = answer;
  }
  const plain = decryptExportBuffer(bytes, key);
  const tempPath = join(tmpdir(), `muse-import-${process.pid.toString()}-${Date.now().toString()}.tar.gz`);
  await writeFile(tempPath, plain, { mode: 0o600 });
  return { path: tempPath, tempPath };
}

/**
 * A bundle entry is only restored when it is a real file under the
 * `.muse/` prefix the export command produces. The `.muse/` prefix
 * alone does NOT confine it: `.muse/../../.ssh/authorized_keys`
 * starts with `.muse/` yet escapes the target dir, and a `..`-free
 * top-level entry like `.bashrc` would land straight in `$HOME`.
 * Both the manifest/collision surface AND the extractor below use
 * this predicate, and the extractor passes the vetted list to tar
 * as explicit members — so a hand-rolled tar with extra junk or a
 * path-traversal entry genuinely cannot write outside `~/.muse`.
 * Exported for direct test coverage.
 */
export function isSafeMuseEntry(entry: string): boolean {
  if (!entry.startsWith(MUSE_PREFIX) || entry.endsWith("/")) {
    return false;
  }
  if (entry.includes("\\")) {
    return false;
  }
  return !entry.split("/").some((segment) => segment === "..");
}

/**
 * Run `tar -tzf <bundle>` and parse the entries the bundle would
 * extract, keeping only the traversal-safe `.muse/` files (see
 * `isSafeMuseEntry`). Exported for direct test coverage of the
 * filter logic.
 */
export async function listMuseImportEntries(
  bundlePath: string,
  spawnImpl: typeof spawn = spawn
): Promise<readonly string[]> {
  const child = spawnImpl("tar", ["-tzf", bundlePath], { stdio: ["ignore", "pipe", "pipe"] });
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  // Decode ONCE from the fully concatenated bytes on close — never
  // per-chunk — so a multi-byte UTF-8 filename (CJK/emoji entries in
  // the notes tree) split across two `data` events decodes correctly.
  child.stdout.on("data", (chunk: Buffer) => { outChunks.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { errChunks.push(chunk); });

  const onError = once(child, "error");
  const onClose = once(child, "close");

  const exitCode = await Promise.race([
    onError.then(([cause]) => {
      throw normalizeChildError(cause);
    }),
    onClose.then(([code]) => {
      if (code === 0 || code === null) {
        return 0;
      }
      throw new Error(`tar -tzf exited with code ${(code ?? -1).toString()}: ${Buffer.concat(errChunks).toString("utf8").trim()}`);
    })
  ]);

  const stdout = exitCode === 0
    ? Buffer.concat(outChunks).toString("utf8")
    : "";
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isSafeMuseEntry(line));
}

/**
 * Inspect the destination home directory for entries that would
 * be overwritten by extracting `entries`. Returns the relative
 * paths (already without the `.muse/` prefix, suitable for
 * surfacing to the user). Exported for direct testing.
 */
export async function findImportCollisions(
  home: string,
  entries: readonly string[]
): Promise<readonly string[]> {
  const checks = entries.map(async (entry) => {
    const abs = join(home, entry);
    const statResult = await withBestEffort(stat(abs), undefined);
    if (!statResult || !statResult.isFile()) {
      return undefined;
    }
    return museEntryRelative(entry);
  });
  const collisions = await Promise.all(checks);
  return collisions.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Extract ONLY the vetted `entries` as explicit tar members. A bare
 * `tar -xzf bundle -C home` extracts every archive member regardless
 * of the `.muse/` filter, so a malicious bundle could write `.bashrc`
 * straight into `$HOME` (no `..` needed) and bypass the collision
 * prompt entirely. Naming the members confines tar to exactly the
 * traversal-safe list the collision check and dry-run already
 * surfaced. Caller guarantees `entries` is non-empty (an empty
 * member list would make tar fall back to extracting everything).
 * Exported for direct test coverage.
 */
export async function extractMuseBundle(
  bundlePath: string,
  home: string,
  entries: readonly string[],
  spawnImpl: typeof spawn = spawn
): Promise<void> {
  const child = spawnImpl("tar", ["-xzf", bundlePath, "-C", home, "--", ...entries], { stdio: ["ignore", "ignore", "pipe"] });
  const errChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => { errChunks.push(chunk); });

  const onError = once(child, "error");
  const onClose = once(child, "close");

  await Promise.race([
    onError.then(([cause]) => {
      throw normalizeChildError(cause);
    }),
    onClose.then(([code]) => {
      if (code === 0 || code === null) {
        return;
      }
      throw new Error(`tar -xzf exited with code ${(code ?? -1).toString()}: ${Buffer.concat(errChunks).toString("utf8").trim()}`);
    })
  ]);
}

function normalizeChildError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(typeof cause === "string" ? cause : "command execution failed");
}

export function registerImportCommand(program: Command, io: ProgramIO): void {
  program
    .command("import")
    .description("Restore a `muse export` tarball into ~/.muse/. Refuses to overwrite without --force.")
    .argument("<bundle>", "Path to a `.tar.gz` produced by `muse export` (encrypted `.enc` bundles auto-detected)")
    .option("--force", "Overwrite existing ~/.muse/* files when they collide with bundle entries")
    .option("--dry-run", "Print the plan without touching disk")
    .option("--decrypt", "Require an encrypted bundle (passphrase via $MUSE_EXPORT_PASSPHRASE or interactive prompt). Auto-detection runs without the flag too.")
    .action(async (bundlePathArg: string, options: ImportOptions) => {
      const bundlePath = resolve(bundlePathArg);
      try {
        await stat(bundlePath);
      } catch {
        io.stderr(commandErrorLine("import", `Bundle not found: ${bundlePath}`));
        process.exitCode = 1;
        return;
      }
      let workingBundle: string;
      let tempPath: string | undefined;
      try {
        const decrypted = await decryptToTempIfNeeded(bundlePath, options.decrypt === true);
        workingBundle = decrypted.path;
        tempPath = decrypted.tempPath;
      } catch (cause) {
        io.stderr(commandErrorLine("import", cause instanceof Error ? cause.message : String(cause)));
        process.exitCode = 1;
        return;
      }
      try {
        const entries = await listMuseImportEntries(workingBundle);
        if (entries.length === 0) {
          io.stderr(commandErrorLine("import", `Bundle ${bundlePath} contains no .muse/* entries — refusing to extract.`));
          process.exitCode = 1;
          return;
        }
        const home = homedir();
        const collisions = await findImportCollisions(home, entries);

        if (options.dryRun) {
          io.stdout(`Plan for ${bundlePath} → ${home}:\n`);
          const collisionSet = new Set(collisions);
          for (const entry of entries) {
            const rel = museEntryRelative(entry);
            const willOverwrite = collisionSet.has(rel);
            io.stdout(`  ${willOverwrite ? "OVERWRITE" : "create   "} ~/.muse/${rel}\n`);
          }
          io.stdout(`\n${entries.length.toString()} entry/entries, ${collisions.length.toString()} collision(s).\n`);
          return;
        }

        if (collisions.length > 0 && !options.force) {
          io.stderr(`Refusing to overwrite ${collisions.length.toString()} existing file(s) in ~/.muse:\n`);
          for (const rel of collisions.slice(0, 10)) {
            io.stderr(`  - ${rel}\n`);
          }
          if (collisions.length > 10) {
            io.stderr(`  - … (${(collisions.length - 10).toString()} more)\n`);
          }
          io.stderr(`Re-run with --force to overwrite, or --dry-run to inspect.\n`);
          process.exitCode = 1;
          return;
        }

        await extractMuseBundle(workingBundle, home, entries);
        io.stdout(`Restored ${entries.length.toString()} file(s) into ~/.muse from ${bundlePath}\n`);
        if (collisions.length > 0) {
          io.stdout(`  (${collisions.length.toString()} pre-existing file(s) overwritten via --force)\n`);
        }
      } finally {
        if (tempPath) {
          await withBestEffort(unlink(tempPath), undefined);
        }
      }
    });
}
