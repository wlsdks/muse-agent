/**
 * Path sandbox — the deterministic, fail-close security boundary under
 * every `@muse/fs` tool. The allow-root is broad (the user's home dir by
 * default, so Muse can "freely control the Mac"), which makes the
 * DENY-LIST the real boundary: credential stores, key material, and
 * Muse's own secret/state dirs are refused even though they live under
 * home. A path that resolves outside every root, or that hits the
 * deny-list, throws `PathSafetyError` BEFORE any filesystem op runs.
 *
 * Symlink escape is closed by canonicalizing (resolving symlinks on the
 * deepest existing ancestor) before the check — a symlink inside a root
 * pointing at `/etc` resolves to `/etc` and is rejected. `..` traversal
 * collapses the same way. This is code, never a prompt instruction.
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type PathSafetyDenyReason = "outside_roots" | "denied_path" | "denied_pattern";

export class PathSafetyError extends Error {
  readonly reason: PathSafetyDenyReason;
  readonly attempted: string;

  constructor(reason: PathSafetyDenyReason, attempted: string, message: string) {
    super(message);
    this.name = "PathSafetyError";
    this.reason = reason;
    this.attempted = attempted;
  }
}

export interface PathSafetyOptions {
  /** Allow-roots; a resolved path must live under one of these. Default: home dir + baseDir. */
  readonly roots?: readonly string[];
  /** Extra deny prefixes (dirs/files) on top of the built-in credential defaults. */
  readonly extraDeny?: readonly string[];
  /** Base dir for resolving relative inputs. Default: `process.cwd()`. */
  readonly baseDir?: string;
}

/** Directory/file prefixes refused even when they sit under an allow-root. */
const DEFAULT_DENY_DIRS: readonly string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gh",
  "~/.config/muse",
  "~/.kube",
  "~/.docker",
  "~/Library/Keychains"
];

/** Path SEGMENTS that are denied wherever they appear (e.g. a project-local `.muse/`). */
const DEFAULT_DENY_SEGMENTS: ReadonlySet<string> = new Set([".ssh", ".aws", ".gnupg", ".muse", "secrets", "credentials"]);

/**
 * Patterns refused on ANY path segment — a sensitive DIRECTORY (`~/x/secrets/…`,
 * `~/app-credentials/…`) is as dangerous as a sensitive file under the broad home
 * root. Precise enough not to false-positive on ordinary dir names. The broad
 * `token` rule is NOT here (it would block a legit `token-ring/` dir); it stays
 * basename-only below.
 */
const DEFAULT_DENY_SEGMENT_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/iu,
  /(^|[._-])secrets?([._-]|$)/iu,
  /(^|[._-])credentials?([._-]|$)/iu,
  /\.pem$/iu,
  /^id_(rsa|ed25519|ecdsa|dsa)$/iu
];

/** Patterns refused on the leaf (filename) only — broader than the segment set. */
const DEFAULT_DENY_BASENAME_PATTERNS: readonly RegExp[] = [
  ...DEFAULT_DENY_SEGMENT_PATTERNS,
  /(^|[._-])token([._-]|$)/iu
];

function expandHome(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith(`~${sep}`) || input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/**
 * Resolve `input` to an absolute path with symlinks collapsed. `realpath`
 * only works on a path that exists, so for a not-yet-created target (a
 * `file_write` destination) we realpath the deepest EXISTING ancestor and
 * re-append the missing tail — closing a symlinked-parent escape without
 * requiring the leaf to exist.
 */
async function canonicalize(input: string, baseDir: string): Promise<string> {
  const expanded = expandHome(input);
  const abs = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);

  let current = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        return abs;
      }
      tail.push(basename(current));
      current = parent;
    }
  }
}

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * Deny matching is case-INSENSITIVE on purpose: macOS (APFS/HFS+) is
 * case-insensitive by default, so `~/.SSH/key` and `~/.ssh/key` are the same
 * file. A case-sensitive deny would let `~/.SSH/newkey` (a not-yet-existing
 * path, so `realpath` can't normalize its case) slip past the `.ssh` rule.
 * Matching case-insensitively is never less safe.
 */
function isUnderCI(child: string, parent: string): boolean {
  return isUnder(child.toLowerCase(), parent.toLowerCase());
}

export interface ResolvedPolicy {
  readonly roots: readonly string[];
  readonly denyDirs: readonly string[];
}

/**
 * Canonicalize the allow-roots + deny-dirs once so per-call checks are
 * pure string comparisons. Deny-dirs that don't exist still canonicalize
 * (via the ancestor walk), so `~/.ssh` is enforced even on a box without one.
 */
export async function resolvePolicy(options: PathSafetyOptions = {}): Promise<ResolvedPolicy> {
  const baseDir = options.baseDir ?? process.cwd();
  const rawRoots = options.roots && options.roots.length > 0 ? options.roots : [homedir(), baseDir];
  const roots = await Promise.all(rawRoots.map((root) => canonicalize(root, baseDir)));
  const rawDeny = [...DEFAULT_DENY_DIRS, ...(options.extraDeny ?? [])];
  const denyDirs = await Promise.all(rawDeny.map((deny) => canonicalize(deny, baseDir)));
  return { denyDirs, roots };
}

/**
 * Resolve `input` and assert it is allowed, returning the canonical
 * absolute path. Throws `PathSafetyError` (fail-close) on any violation —
 * never returns a best-guess path.
 */
export async function resolveSafePath(
  input: string,
  options: PathSafetyOptions = {},
  resolved?: ResolvedPolicy
): Promise<string> {
  const baseDir = options.baseDir ?? process.cwd();
  const policy = resolved ?? (await resolvePolicy(options));
  const canonical = await canonicalize(input, baseDir);

  if (!policy.roots.some((root) => isUnder(canonical, root))) {
    throw new PathSafetyError(
      "outside_roots",
      input,
      `Path '${input}' resolves outside the allowed roots and was refused.`
    );
  }

  for (const deny of policy.denyDirs) {
    if (isUnderCI(canonical, deny)) {
      throw new PathSafetyError("denied_path", input, `Path '${input}' is in a protected location and was refused.`);
    }
  }

  const segments = canonical.split(sep).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (DEFAULT_DENY_SEGMENTS.has(segment.toLowerCase())) {
      throw new PathSafetyError("denied_path", input, `Path '${input}' touches a protected directory ('${segment}') and was refused.`);
    }
    if (DEFAULT_DENY_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))) {
      throw new PathSafetyError("denied_pattern", input, `Path '${input}' touches a protected secret path ('${segment}') and was refused.`);
    }
  }

  const leaf = basename(canonical);
  if (DEFAULT_DENY_BASENAME_PATTERNS.some((pattern) => pattern.test(leaf))) {
    throw new PathSafetyError("denied_pattern", input, `Path '${input}' matches a protected secret pattern and was refused.`);
  }

  return canonical;
}

/** True when `error` is a fail-close path refusal (vs an IO error). */
export function isPathSafetyError(error: unknown): error is PathSafetyError {
  return error instanceof PathSafetyError;
}

function splitPathList(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[:,]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Sandbox overrides from the environment — `MUSE_FS_ROOTS` NARROWS the allow-root
 * (a strict user can confine the fs tools to e.g. `~/notes`), `MUSE_FS_DENY` ADDS
 * deny prefixes on top of the built-in credential defaults. Both accept a `:` or
 * `,` separated list. Returns `{}` when neither is set (default = home root).
 */
export function pathSafetyOptionsFromEnv(env: Readonly<Record<string, string | undefined>>): PathSafetyOptions {
  const roots = splitPathList(env["MUSE_FS_ROOTS"]);
  const extraDeny = splitPathList(env["MUSE_FS_DENY"]);
  return {
    ...(roots.length > 0 ? { roots } : {}),
    ...(extraDeny.length > 0 ? { extraDeny } : {})
  };
}
