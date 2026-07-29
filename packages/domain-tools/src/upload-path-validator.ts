/**
 * `createAllowlistPathValidator` — the SAME local-read guard `file_read` uses,
 * lifted into a standalone, injectable validator so a capability in another
 * package (e.g. `@muse/browser`'s `browser_upload`) can reuse it without
 * depending on `@muse/mcp`'s tool code: the validator is dependency-injected at
 * the CLI boundary, never an allow-all path read.
 *
 * The contract is fail-closed: a path is allowed ONLY when it lexically sits
 * inside an allowed root AND its real (post-symlink) path is still inside a
 * root. A symlink that escapes the roots, a path outside them, or a realpath
 * error (missing/broken target) all REFUSE. This is exactly the posture that
 * stops a prompt-injected page steering an upload at `~/.ssh/id_rsa`.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdtemp, open, realpath as nodeRealpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve as pathResolve, sep as pathSep } from "node:path";

export type PathValidationResult =
  | {
      readonly allowed: true;
      readonly cleanup: () => Promise<void>;
      readonly identity: UploadFileIdentity;
      readonly resolvedPath: string;
      readonly uploadPath: string;
    }
  | { readonly allowed: false; readonly reason: string };

export interface UploadFileIdentity {
  readonly bytes: number;
  readonly changedAtMs: number;
  readonly device: number;
  readonly inode: number;
  readonly modifiedAtMs: number;
  readonly sha256: string;
}

/**
 * Resolves a free-text/raw local path to an allow/deny decision. Async because
 * the symlink-escape check calls realpath. The same shape `browser_upload`'s
 * injected `validatePath` seam expects.
 */
export type AllowlistPathValidator = (path: string) => Promise<PathValidationResult>;

export interface AllowlistPathValidatorOptions {
  /** Folders an upload source may come from (e.g. file_read's roots). */
  readonly roots: readonly string[];
  /** Symlink resolver; defaults to node:fs realpath. Tests inject a fake. */
  readonly realpath?: (path: string) => Promise<string>;
  /** Home dir for `~` expansion; defaults to os.homedir(). */
  readonly home?: string;
  /** Test seam; production creates a private content-stable staging copy. */
  readonly inspectFile?: (path: string) => Promise<UploadFileIdentity>;
}

async function prepareUploadFile(path: string): Promise<{
  readonly cleanup: () => Promise<void>;
  readonly identity: UploadFileIdentity;
  readonly uploadPath: string;
}> {
  const handle = await open(path, fsConstants.O_NOFOLLOW | fsConstants.O_RDONLY);
  let stagingDir: string | undefined;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("upload source is not a regular file");
    stagingDir = await mkdtemp(join(tmpdir(), "muse-upload-"));
    const uploadPath = join(stagingDir, basename(path));
    const staged = await open(
      uploadPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_WRONLY,
      0o600
    );
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    try {
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
        if (bytesRead === 0) break;
        hash.update(chunk.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await staged.write(
            chunk,
            written,
            bytesRead - written,
            position + written
          );
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      await staged.sync();
      await staged.chmod(0o400);
    } finally {
      await staged.close();
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || position !== after.size
    ) {
      throw new Error("upload source changed while hashing");
    }
    return {
      cleanup: async () => rm(stagingDir!, { force: true, recursive: true }),
      identity: {
        bytes: after.size,
        changedAtMs: after.ctimeMs,
        device: after.dev,
        inode: after.ino,
        modifiedAtMs: after.mtimeMs,
        sha256: hash.digest("hex")
      },
      uploadPath
    };
  } catch (cause) {
    if (stagingDir) await rm(stagingDir, { force: true, recursive: true });
    throw cause;
  } finally {
    await handle.close();
  }
}

export function createAllowlistPathValidator(options: AllowlistPathValidatorOptions): AllowlistPathValidator {
  const home = options.home ?? homedir();
  const roots = options.roots.map((root) => pathResolve(root.replace(/^~(?=\/|$)/, home)));
  const realpathOf = options.realpath ?? nodeRealpath;
  const inspectFile = options.inspectFile;
  const within = (candidate: string, base: string): boolean => candidate === base || candidate.startsWith(`${base}${pathSep}`);
  return async (raw) => {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed.length === 0) {
      return { allowed: false, reason: "no path given" };
    }
    const resolved = pathResolve(trimmed.replace(/^~(?=\/|$)/, home));
    if (!roots.some((root) => within(resolved, root))) {
      return { allowed: false, reason: `'${raw}' is outside the readable folders (${roots.join(", ")})` };
    }
    // Symlink-escape guard: a file lexically inside the roots may be a link
    // pointing OUTSIDE them. Re-check the REAL path (and realpath the roots too
    // — /tmp is itself a symlink on macOS). A realpath error (missing/broken
    // target) fails closed — never allowed.
    let realTarget: string;
    try {
      realTarget = await realpathOf(resolved);
    } catch {
      return { allowed: false, reason: `'${raw}' could not be resolved on disk` };
    }
    const realRoots = await Promise.all(roots.map((root) => realpathOf(root).catch(() => root)));
    if (!realRoots.some((root) => within(realTarget, root))) {
      return { allowed: false, reason: `'${raw}' resolves through a link to outside the readable folders` };
    }
    try {
      if (inspectFile) {
        return {
          allowed: true,
          cleanup: async () => {},
          identity: await inspectFile(realTarget),
          resolvedPath: realTarget,
          uploadPath: realTarget
        };
      }
      const prepared = await prepareUploadFile(realTarget);
      return {
        allowed: true,
        ...prepared,
        resolvedPath: realTarget
      };
    } catch {
      return { allowed: false, reason: `'${raw}' is not a stable regular file` };
    }
  };
}
