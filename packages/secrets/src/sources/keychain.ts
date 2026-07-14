import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SecretRef, SecretSource } from "../types.js";

/** The macOS `security` binary — a FIXED, allowlisted executable path. */
export const SECURITY_BIN = "/usr/bin/security";

/**
 * Injectable runner over a FIXED executable + argv ARRAY. The default spawns
 * `node:child_process.execFile` (no shell). Tests pass a mock to assert the
 * argv is an array of literal elements — never a shell string.
 */
export type ArgvRunner = (
  file: string,
  args: readonly string[]
) => Promise<{ readonly stdout: string }>;

const execFileAsync = promisify(execFile);

const defaultRunner: ArgvRunner = async (file, args) => {
  // execFile takes a FIXED executable + an argv ARRAY: the OS execve's it
  // directly, so NO shell parses it — a name like `; rm -rf ~` is one inert
  // argument, never a command. (Never `exec` with an interpolated string.)
  const { stdout } = await execFileAsync(file, [...args], { encoding: "utf8", timeout: 5_000 }) as { stdout: string };
  return { stdout };
};

export interface KeychainSourceOptions {
  /** Keychain item service (`-s`). Defaults to `ref.service ?? "muse"`. */
  readonly service?: (ref: SecretRef) => string;
  /** Keychain item account (`-a`). Defaults to `ref.name`. */
  readonly account?: (ref: SecretRef) => string;
  /** Override the subprocess runner (tests). */
  readonly runner?: ArgvRunner;
}

/**
 * macOS Keychain reader. Spawns
 * `security find-generic-password -w -s <service> -a <name>` with a FIXED argv
 * array — the secret NAME is passed as a literal argv element, so shell
 * metacharacters in it cannot inject. `local: true` (the value never leaves the
 * box). A miss, a locked vault, or any non-zero exit ⇒ `undefined` (fail-open
 * to the next source), never a throw — a credential lookup must not crash the
 * agent.
 */
export function createKeychainSource(options: KeychainSourceOptions = {}): SecretSource {
  const run = options.runner ?? defaultRunner;
  const serviceOf = options.service ?? ((ref: SecretRef) => ref.service ?? "muse");
  const accountOf = options.account ?? ((ref: SecretRef) => ref.name);

  return {
    id: "keychain",
    local: true,
    async get(ref: SecretRef): Promise<string | undefined> {
      const args = ["find-generic-password", "-w", "-s", serviceOf(ref), "-a", accountOf(ref)];
      try {
        const { stdout } = await run(SECURITY_BIN, args);
        // `-w` prints just the password followed by a newline; a real value
        // can legitimately contain interior newlines, so strip only ONE
        // trailing line ending, not every whitespace char.
        const value = stdout.replace(/\r?\n$/u, "");
        return value.length > 0 ? value : undefined;
      } catch {
        return undefined;
      }
    }
  };
}
