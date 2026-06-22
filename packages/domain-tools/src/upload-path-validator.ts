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

import { realpath as nodeRealpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as pathResolve, sep as pathSep } from "node:path";

export type PathValidationResult =
  | { readonly allowed: true; readonly resolvedPath: string }
  | { readonly allowed: false; readonly reason: string };

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
}

export function createAllowlistPathValidator(options: AllowlistPathValidatorOptions): AllowlistPathValidator {
  const home = options.home ?? homedir();
  const roots = options.roots.map((root) => pathResolve(root.replace(/^~(?=\/|$)/, home)));
  const realpathOf = options.realpath ?? nodeRealpath;
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
    return { allowed: true, resolvedPath: realTarget };
  };
}
