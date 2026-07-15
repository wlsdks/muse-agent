/**
 * `muse export [--output <path>]` — backup every ~/.muse JSON
 * store + the notes directory into a single timestamped tar.gz.
 *
 * Useful for laptop migration and "before the upgrade"
 * snapshots. The archive layout mirrors `~/.muse/` so restore is a
 * single `tar -xzf` into the new home. A `README.md` listed inside
 * the tarball names every captured file + the restore command.
 *
 * No CLI deps beyond Node's bundled `node:zlib` + the `tar` package
 * already used elsewhere in the workspace.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readdir, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";



import type { Command } from "commander";

import { encryptExportBuffer } from "./export-crypto.js";
import type { ProgramIO } from "./program.js";
import { withBestEffort } from "./async-promises.js";

interface ExportOptions {
  readonly output?: string;
  readonly include?: string;
  /**
   * Wrap the bundle with AES-256-GCM. Passphrase comes
   * from `MUSE_EXPORT_PASSPHRASE` env when set; the CLI falls
   * back to stdin (with an interactive prompt) otherwise. Output
   * filename gets `.enc` suffix when encrypted.
   */
  readonly encrypt?: boolean;
}

/**
 * Files we consider "user state". Path is relative to
 * `~/.muse/`. The notes directory is handled separately because
 * it's a tree, not a single file.
 */
export const DEFAULT_EXPORT_FILES: readonly string[] = [
  "credentials.json",
  "models.json",
  "calendar-credentials.json",
  "messaging.json",
  "tasks.json",
  "reminders.json",
  "reminder-history.json",
  "followups.json",
  "episodes.json",
  "patterns-fired.json",
  "proactive-history.json",
  "user-memory.json",
  "contacts.json",
  "feeds.json",
  "objectives.json",
  "vetoes.json",
  "persona.json",
  "calendar.json",
  "line-inbox.json",
  "telegram-inbox.json",
  "discord-inbox.json",
  "slack-inbox.json",
  "notes-index.json",
  "episodes-index.json",
  "trust.json",
  "config.json"
];

/**
 * Default notes directory under `~/.muse/notes` — overridden by
 * `MUSE_NOTES_DIR` at the call site. Exported for direct test
 * coverage so a fixture can verify the tree is included when the
 * dir exists and quietly skipped when it doesn't.
 */
function defaultNotesDir(): string {
  const fromEnv = process.env.MUSE_NOTES_DIR?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".muse", "notes");
}

function defaultExportOutput(): string {
  // ISO timestamp without colons (Windows + tar both prefer that).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(process.cwd(), `muse-backup-${stamp}.tar.gz`);
}

/**
 * Build the README that ships inside the archive. Lists every file
 * the export touched + the restore command. Exported for the test
 * suite to assert the contents.
 */
export function buildExportReadme(
  includedFiles: readonly string[],
  includedNotesDir: string | undefined,
  createdAtIso: string
): string {
  const lines: string[] = [];
  lines.push("# Muse export bundle");
  lines.push("");
  lines.push(`Created: ${createdAtIso}`);
  lines.push("");
  lines.push("## Contents");
  lines.push("");
  if (includedFiles.length === 0) {
    lines.push("(no ~/.muse/*.json stores found on this host)");
  } else {
    for (const file of includedFiles) {
      lines.push(`- \`.muse/${file}\``);
    }
  }
  if (includedNotesDir) {
    lines.push(`- \`.muse/notes/\` — full notes tree (from \`${includedNotesDir}\`)`);
  }
  lines.push("");
  lines.push("## Restore");
  lines.push("");
  lines.push("```sh");
  lines.push("# review first, then extract over your existing ~/.muse");
  lines.push("tar -tzf <this-bundle>.tar.gz");
  lines.push("tar -xzf <this-bundle>.tar.gz -C \"$HOME\"");
  lines.push("```");
  lines.push("");
  lines.push("The archive is laid out so a single `tar -xzf` re-creates");
  lines.push("`~/.muse/` exactly as it was when the bundle was written.");
  lines.push("");
  return lines.join("\n");
}

/**
 * Pre-create the intermediate cleartext tarball at owner-only
 * perms. The encrypt path tars secrets (credentials.json,
 * messaging.json, …) to this temp before encrypting;
 * `tar -f` truncates an existing file *without* resetting its
 * mode, so reserving it 0o600 first means the cleartext bundle is
 * never world-readable on a multi-user host for the encrypt
 * window. `chmod` covers a stale temp left by a hard-killed run
 * (writeFile's `mode` is ignored when the file already exists).
 * Exported for direct test coverage.
 */
export async function reserveCleartextTemp(path: string): Promise<void> {
  await writeFile(path, "", { mode: 0o600 });
  await chmod(path, 0o600);
}

interface CollectedSources {
  readonly files: readonly string[];
  readonly notesDir: string | undefined;
}

async function collectSources(museDir: string, notesDir: string): Promise<CollectedSources> {
  const filesPresent: string[] = [];
  for (const rel of DEFAULT_EXPORT_FILES) {
    const abs = join(museDir, rel);
    try {
      const s = await stat(abs);
      if (s.isFile() && s.size > 0) {
        filesPresent.push(rel);
      }
    } catch {
      // missing file — that's the common case, skip it
    }
  }
  let notesIncluded: string | undefined;
  try {
    const s = await stat(notesDir);
    if (s.isDirectory()) {
      // Empty dir → still skip (no point archiving zero entries).
      const entries = await readdir(notesDir);
      if (entries.length > 0) {
        notesIncluded = notesDir;
      }
    }
  } catch {
    // missing notes dir
  }
  return { files: filesPresent, notesDir: notesIncluded };
}

/**
 * Exported for direct unit test — given a temp `~/.muse` and notes
 * dir, write a tarball at `outputPath` and return the manifest that
 * was bundled. Splitting it out keeps the registration thin and
 * the assertion surface narrow.
 *
 * When `passphrase` is set, the tar is built to a temp
 * path, then encrypted in one pass and written to `outputPath`.
 * The temp tarball is unlinked even if encryption throws so we
 * never leave a cleartext shadow next to the encrypted bundle.
 */
export async function buildMuseExport(args: {
  readonly museDir: string;
  readonly notesDir: string;
  readonly outputPath: string;
  readonly nowIso?: string;
  readonly passphrase?: string;
  readonly spawnImpl?: typeof spawn;
}): Promise<{ readonly outputPath: string; readonly files: readonly string[]; readonly notesIncluded: boolean; readonly encrypted: boolean }> {
  const spawnImpl = args.spawnImpl ?? spawn;
  const sources = await collectSources(args.museDir, args.notesDir);

  // When encrypting, build the tar into a temp sibling of the
  // final output then encrypt+unlink, so a partial failure
  // doesn't strand a cleartext file in cwd.
  const passphrase = args.passphrase;
  const tarPath = passphrase ? `${args.outputPath}.cleartext.tmp` : args.outputPath;

  await mkdir(dirname(args.outputPath), { recursive: true });

  // Drop the README into the muse dir under a transient name so
  // it lands inside the tar at `.muse/README.md`. Unlink after the
  // archive closes so we don't leave it behind in a real
  // `~/.muse/`. A tiny race window with concurrent muse processes
  // is acceptable for a single-user backup tool.
  const readme = buildExportReadme(sources.files, sources.notesDir, args.nowIso ?? new Date().toISOString());
  const readmePath = join(args.museDir, "README.export.md");
  await writeFile(readmePath, readme, { encoding: "utf8" });

  const tarEntries: string[] = ["README.export.md", ...sources.files];
  if (sources.notesDir) {
    // include the basename so the archive path becomes
    // `.muse/notes/...` after the rename trick below.
    tarEntries.push("notes");
  }

  try {
    // Shell out to system `tar` — universally available on macOS /
    // Linux. The transform invocation rewrites every entry's leading
    // path component so a top-level `tar -xzf <bundle>.tar.gz -C $HOME`
    // lands directly in `~/.muse/` — no manual move required. We feed
    // entries via the basename of `museDir` (`.muse` in practice) and
    // run `tar -C <parent>` so the archive paths start at `.muse/`.
    const museParent = dirname(args.museDir);
    const museBase = basename(args.museDir);
    const tarArgs = [
      "-c",
      "-z",
      "-f", tarPath,
      "-C", museParent,
      ...tarEntries.map((entry) => `${museBase}/${entry}`)
    ];
    if (passphrase) {
      await reserveCleartextTemp(tarPath);
    }
    const tar = spawnImpl("tar", tarArgs, { stdio: ["ignore", "ignore", "pipe"] });
    const errChunks: Buffer[] = [];
    // Decode ONCE from the fully concatenated bytes on close — never
    // per-chunk — so a multi-byte UTF-8 character in a tar error message
    // (e.g. a non-ASCII path) split across two `data` events decodes
    // correctly instead of U+FFFD on both halves.
    tar.stderr.on("data", (chunk: Buffer) => { errChunks.push(chunk); });

    const onError = once(tar, "error");
    const onClose = once(tar, "close");

    await Promise.race([
      onError.then(([cause]) => {
        throw normalizeChildError(cause);
      }),
      onClose.then(([code]) => {
        if (code === 0 || code === null) {
          return;
        }
        throw new Error(`tar exited with code ${(code ?? -1).toString()}: ${Buffer.concat(errChunks).toString("utf8").trim()}`);
      })
    ]);

    if (passphrase) {
      // Read cleartext tarball, encrypt to the final path, then
      // unlink the cleartext temp. The unlink runs in the outer
      // `finally` so a thrown encrypt also cleans up.
      const plain = await readFile(tarPath);
      const cipher = encryptExportBuffer(plain, passphrase);
      await writeFile(args.outputPath, cipher, { mode: 0o600 });
    }
  } finally {
    await withBestEffort(unlink(readmePath), undefined);
    if (passphrase) {
      await withBestEffort(unlink(tarPath), undefined);
    }
  }

  return {
    outputPath: args.outputPath,
    files: sources.files,
    notesIncluded: sources.notesDir !== undefined,
    encrypted: Boolean(passphrase)
  };
}

function normalizeChildError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(typeof cause === "string" ? cause : "command execution failed");
}

/**
 * When `--encrypt` is set we need a passphrase. Prefer
 * the env so headless / CI flows work without a TTY; fall back to
 * an interactive `@clack/prompts` password input. Exported so the
 * test suite can patch `passphraseFromEnv` directly instead of
 * mocking the prompt library.
 */
async function resolveExportPassphrase(): Promise<string> {
  const fromEnv = process.env.MUSE_EXPORT_PASSPHRASE?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // Lazy import — `@clack/prompts` pulls in tty machinery we
  // don't want in the happy `MUSE_EXPORT_PASSPHRASE` path.
  const { password } = await import("@clack/prompts");
  const answer = await password({ message: "Export passphrase (keep it safe — Muse cannot recover lost passphrases):" });
  if (typeof answer !== "string" || answer.trim().length === 0) {
    throw new Error("export aborted: passphrase is required for --encrypt");
  }
  return answer;
}

export function registerExportCommand(program: Command, io: ProgramIO): void {
  program
    .command("export")
    .description("Bundle every ~/.muse/*.json store + the notes tree into a single timestamped tar.gz")
    .option("--output <path>", "Override the default `./muse-backup-<timestamp>.tar.gz` destination")
    .option("--encrypt", "Encrypt the bundle with AES-256-GCM (passphrase via $MUSE_EXPORT_PASSPHRASE or interactive prompt). Output gets a .enc suffix.")
    .action(async (options: ExportOptions) => {
      const museDir = join(homedir(), ".muse");
      const notesDir = defaultNotesDir();
      let outputPath = resolve(options.output ?? defaultExportOutput());
      if (options.encrypt && !outputPath.endsWith(".enc")) {
        outputPath = `${outputPath}.enc`;
      }
      try {
        await stat(museDir);
      } catch {
        io.stderr(`No ~/.muse directory found at ${museDir}. Nothing to export.\n`);
        process.exitCode = 1;
        return;
      }
      let passphrase: string | undefined;
      if (options.encrypt) {
        try {
          passphrase = await resolveExportPassphrase();
        } catch (cause) {
          io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
          process.exitCode = 1;
          return;
        }
      }
      const summary = await buildMuseExport({
        museDir,
        notesDir,
        outputPath,
        ...(passphrase ? { passphrase } : {})
      });
      io.stdout(`Wrote ${summary.outputPath}${summary.encrypted ? " (encrypted)" : ""}\n`);
      io.stdout(`  ${summary.files.length.toString()} store file(s), notes tree ${summary.notesIncluded ? "included" : "skipped (missing or empty)"}\n`);
      if (summary.encrypted) {
        io.stdout(`Restore: muse import ${summary.outputPath} --decrypt\n`);
      } else {
        io.stdout(`Restore: tar -xzf ${summary.outputPath} -C "$HOME"\n`);
      }
    });
}
