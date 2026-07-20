/**
 * Where `muse-mac-helper` lives at runtime.
 *
 * Resolution order, most explicit first:
 *   1. MUSE_MAC_HELPER — an operator override, and the seam tests use.
 *   2. Next to the running CLI (how a packaged install ships it).
 *   3. The repo's Swift build output (how it works during development).
 *
 * Returns undefined when nothing is found, because "not installed" is a normal
 * state the bridge already degrades from — searching must never throw.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MAC_HELPER_BINARY_NAME = "muse-mac-helper";

export function resolveMacHelperPath(env: NodeJS.ProcessEnv = process.env, argv1: string = process.argv[1] ?? ""): string | undefined {
  const override = env.MUSE_MAC_HELPER?.trim();
  if (override && override.length > 0) {
    return existsSync(override) ? override : undefined;
  }

  const candidates: string[] = [];
  if (argv1.length > 0) {
    const cliDir = dirname(resolve(argv1));
    candidates.push(join(cliDir, MAC_HELPER_BINARY_NAME));
    candidates.push(join(cliDir, "..", MAC_HELPER_BINARY_NAME));
  }
  // Development: the Swift package's release build, relative to this module.
  candidates.push(resolve(dirname(new URL(import.meta.url).pathname), "../../../apps/mac-helper/.build/release/MuseMacHelper"));

  return candidates.find((candidate) => existsSync(candidate));
}
