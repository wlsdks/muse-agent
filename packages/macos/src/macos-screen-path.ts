/**
 * Screenshot output-path security sandbox for mac_screenshot. `screencapture -x`
 * follows a pre-existing symlink AT the target on write (O_TRUNC), so a parent-dir
 * check alone is escapable — `resolveScreenshotPath` realpaths the FULL target and
 * re-checks it stays under an allowed root. Split out of macos-tools.ts so the
 * traversal guard is unit-testable in isolation.
 */

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

export function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function screenshotAllowedRoots(): readonly string[] {
  const home = homedir();
  return [
    join(home, "Desktop"),
    join(home, "Downloads"),
    tryRealpath(tmpdir()),
    tryRealpath("/tmp")
  ];
}

function expandTilde(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function resolveScreenshotPath(
  raw: string,
  realpath: (p: string) => string = tryRealpath
): { ok: true; resolved: string } | { ok: false; error: string } {
  const expanded = expandTilde(raw.trim());
  const name = basename(expanded);
  if (!name || name === "." || name === "..") {
    return { ok: false, error: `path must include a filename, got: ${raw}` };
  }
  const lexicalParent = resolvePath(dirname(expanded));
  const parent = tryRealpath(lexicalParent);
  const allowed = screenshotAllowedRoots();
  const withinRoot = (dir: string): boolean =>
    allowed.some((root) => dir === root || dir.startsWith(root + "/"));
  if (!withinRoot(parent)) {
    return {
      ok: false,
      error: `screenshot path must be under ~/Desktop, ~/Downloads, or the system temp dir — got parent: ${parent}`
    };
  }
  const resolved = resolvePath(parent, name);
  // A pre-existing symlink AT the target is FOLLOWED on write (`screencapture -x`
  // opens with O_TRUNC), so the parent-dir check alone lets `<allowed>/shot.png ->
  // /etc/passwd` escape. Realpath the FULL target and re-check the real write
  // location is still within an allowed root — mirrors the loopback-filesystem
  // symlink-escape fix. A non-existent target realpaths to itself (no escape).
  const realTarget = realpath(resolved);
  if (realTarget !== resolved && !withinRoot(tryRealpath(dirname(realTarget)))) {
    return { ok: false, error: `screenshot path resolves through a symlink outside the allowed dirs: ${realTarget}` };
  }
  return { ok: true, resolved };
}
