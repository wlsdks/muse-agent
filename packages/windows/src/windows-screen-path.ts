/**
 * Screenshot output-path sandbox for win_screenshot — the win32 mirror of
 * macos-screen-path: the PNG save follows a pre-existing symlink/junction at
 * the target, so the FULL target is realpathed and re-checked against the
 * allowed roots, not just its parent directory.
 */

import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath, sep } from "node:path";

export function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function screenshotAllowedRoots(): readonly string[] {
  const home = homedir();
  return [
    join(home, "Pictures"),
    join(home, "Desktop"),
    join(home, "Downloads"),
    tryRealpath(tmpdir())
  ];
}

export function defaultScreenshotPath(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return join(tryRealpath(tmpdir()), `muse-screenshot-${stamp}.png`);
}

export function resolveWindowsScreenshotPath(
  raw: string | undefined,
  realpath: (p: string) => string = tryRealpath,
  symlinkAt: (p: string) => boolean = isSymlink
): { ok: true; resolved: string } | { ok: false; error: string } {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) {
    return { ok: true, resolved: defaultScreenshotPath() };
  }
  const expanded = trimmed.startsWith("~/") || trimmed.startsWith("~\\")
    ? join(homedir(), trimmed.slice(2))
    : trimmed;
  const name = basename(expanded);
  if (!name || name === "." || name === "..") {
    return { error: `path must include a filename, got: ${raw ?? ""}`, ok: false };
  }
  if (!/\.png$/iu.test(name)) {
    return { error: `screenshot path must end in .png, got: ${name}`, ok: false };
  }
  const parent = tryRealpath(resolvePath(dirname(expanded)));
  const allowed = screenshotAllowedRoots();
  const withinRoot = (dir: string): boolean =>
    allowed.some((root) => dir === root || dir.startsWith(root + sep));
  if (!withinRoot(parent)) {
    return {
      error: `screenshot path must be under ~/Pictures, ~/Desktop, ~/Downloads, or the system temp dir — got parent: ${parent}`,
      ok: false
    };
  }
  const resolved = resolvePath(parent, name);
  if (symlinkAt(resolved)) {
    return { error: `screenshot path is a symlink and could redirect the write outside the allowed dirs: ${resolved}`, ok: false };
  }
  const realTarget = realpath(resolved);
  if (realTarget !== resolved && !withinRoot(tryRealpath(dirname(realTarget)))) {
    return { error: `screenshot path resolves through a link outside the allowed dirs: ${realTarget}`, ok: false };
  }
  return { ok: true, resolved };
}
