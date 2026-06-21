/**
 * The CLI version string + a pre-framework fast path for `muse --version`.
 *
 * `index.ts` statically pulled in `program.ts`, which eagerly imports the
 * entire command graph (~100+ modules) at process start — so even the most
 * trivial probe (`muse --version`, run by wrappers, shell-completion warmup,
 * and CI health checks) paid the full ~0.5s import tax. This LEAF module
 * carries no heavy imports, so handling `--version` here and only THEN
 * dynamically importing the framework keeps the common probe near-instant.
 *
 * `MUSE_CLI_VERSION` is the single source the fast path AND commander's
 * `.version(...)` read, so they can never disagree. It tracks the product
 * version (the git tag / root package.json / CHANGELOG); a drift test pins
 * it to the root manifest so a release bump can't silently leave it stale.
 */
export const MUSE_CLI_VERSION = "0.1.0";

/**
 * Print the version and report handled=true ONLY for the exact, unambiguous
 * `muse --version` / `muse -V` invocation (nothing else on the line). Any
 * other argv returns false so the full commander program runs as before —
 * the fast path never changes behaviour, it only skips the import graph for
 * the one trivial case.
 */
export function tryVersionFastPath(argv: readonly string[], write: (text: string) => void): boolean {
  const args = argv.slice(2);
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    write(`${MUSE_CLI_VERSION}\n`);
    return true;
  }
  return false;
}
