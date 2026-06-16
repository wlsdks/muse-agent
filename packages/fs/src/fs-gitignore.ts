/**
 * `.gitignore`-aware filtering for `file_list` / `file_grep`, so search results
 * match developer expectation (skip `node_modules`, build output, etc.) the way
 * ripgrep does — rather than a fixed hardcoded blocklist.
 *
 * Pragmatic scope: from the search directory we walk UP to the nearest git repo
 * root (the dir holding `.git`) and collect every `.gitignore` on that path,
 * matching results relative to the repo root. This honours the dominant case (a
 * repo-root `.gitignore`); deeply-nested per-directory `.gitignore` files below
 * the search root are not separately rooted (a documented v1 limitation). `.git`
 * itself is always ignored. When there is no `.gitignore` at all, the filter is
 * a no-op (it never hides anything), so non-repo folders (notes, Documents) are
 * unaffected.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import ignore, { type Ignore } from "ignore";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Nearest ancestor (inclusive) containing a `.git` entry, else `start`. */
async function findRepoRoot(start: string): Promise<string> {
  let dir = start;
  for (;;) {
    if (await pathExists(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return start;
    }
    dir = parent;
  }
}

export interface IgnoreFilter {
  /** Repo root the patterns are relative to. */
  readonly root: string;
  /** True when `absolutePath` is git-ignored (or inside `.git`). */
  ignores(absolutePath: string): boolean;
}

/**
 * Build a `.gitignore` filter for a search directory. Always ignores `.git`.
 * Returns a filter whose `ignores()` is a pure predicate over absolute paths.
 */
export async function createIgnoreFilter(searchDir: string): Promise<IgnoreFilter> {
  const root = await findRepoRoot(searchDir);
  const ig: Ignore = ignore();
  ig.add(".git");

  // Collect .gitignore files from the repo root down to the search dir.
  const chain: string[] = [];
  let dir = searchDir;
  for (;;) {
    chain.push(dir);
    if (dir === root) {
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  for (const folder of chain.reverse()) {
    const content = await readIfPresent(join(folder, ".gitignore"));
    if (content) {
      ig.add(content);
    }
  }

  return {
    ignores(absolutePath: string): boolean {
      const rel = relative(root, absolutePath);
      // A path outside the repo root can't be expressed as a gitignore-relative
      // path (it would start with ".."), so treat it as not-ignored here — the
      // sandbox, not gitignore, is what bounds those.
      if (rel.length === 0 || rel.startsWith(`..${sep}`) || rel === "..") {
        return false;
      }
      return ig.ignores(rel);
    },
    root
  };
}
