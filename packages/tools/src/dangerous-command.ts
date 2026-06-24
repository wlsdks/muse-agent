/**
 * Deterministic catastrophic-command guard for the `run_command` tool.
 *
 * `run_command` is already `risk: "execute"` (approval-gated), but an
 * approval gate can be bypassed by an auto-approve / autonomous mode — and
 * some commands are IRREVERSIBLE enough that they should never run on a
 * single-user machine on a model's say-so, gate or not. This classifies
 * that narrow, unambiguous set so the tool can FAIL-CLOSE (refuse in code,
 * per "guards are deterministic code, never prompt instruction").
 *
 * Scope is deliberately TIGHT — only the irreversible-with-no-legit-agent-
 * use patterns. Reversible or routine-but-risky work (a relative `rm -rf
 * ./build`, a `curl … | sh` install) is NOT refused here; it stays under
 * the normal execute-approval gate. False positives are worse than a near
 * miss, so each pattern targets a catastrophic TARGET (root, home, a raw
 * device), not the verb alone.
 */

export interface DangerousCommandVerdict {
  readonly dangerous: boolean;
  readonly reason?: string;
}

const SAFE: DangerousCommandVerdict = { dangerous: false };

const RULES: readonly (readonly [RegExp, string])[] = [
  // Recursive force-delete of root, home, or a root-glob.
  [/\brm\s+(?:-[a-z]*\s+)*-?[a-z]*\b[rf][a-z]*\s+(?:-[a-z]+\s+)*(?:\/|~|\$HOME)(?:\/\*?)?(?:\s|$)/iu, "recursive delete of root or home directory"],
  [/\brm\s+(?:-[a-z]+\s+)*\/\*/u, "recursive delete of a root glob"],
  // Classic fork bomb.
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/u, "fork bomb"],
  // Writing a raw block device (disk wipe).
  [/\bdd\b[^\n]*\bof=\/dev\/(?:sd|hd|nvme|disk|rdisk|vd)/iu, "raw write to a block device"],
  [/>\s*\/dev\/(?:sd|hd|nvme|disk|rdisk|vd)[a-z0-9]*/iu, "redirect over a block device"],
  // Formatting a filesystem.
  [/\bmkfs(?:\.[a-z0-9]+)?\s+[^\n]*\/dev\//iu, "filesystem format of a device"],
  // Overwrite the whole disk with zeros/urandom via dd handled above; also catch wipefs.
  [/\bwipefs\b[^\n]*\/dev\//iu, "wipe filesystem signatures from a device"],
  // Recursive permission/ownership change of the ROOT or HOME tree — breaks
  // the OS (sudo/SSH refuse a world-writable tree) and isn't reversible by
  // re-running. Targets bare / · /* · ~ · $HOME only, like the rm rule, so a
  // relative `chmod -R 755 ./dist` passes through.
  [/\bchmod\s+(?:-[a-z]+\s+)*-?[a-zA-Z]*\bR[a-zA-Z]*\s+(?:[0-7]{3,4}|[ugoa]*[+=][rwxXst]+)\s+(?:\/\*?|~\/?|\$HOME)(?:\s|$)/u, "recursive permission change of root or home"],
  [/\bchown\s+(?:-[a-z]+\s+)*-?[a-zA-Z]*\bR[a-zA-Z]*\s+\S+\s+(?:\/\*?|~\/?|\$HOME)(?:\s|$)/u, "recursive ownership change of root or home"]
];

/**
 * Classify a shell command. Returns `{ dangerous: true, reason }` only for
 * an irreversible catastrophic pattern; `{ dangerous: false }` otherwise.
 * Pure + deterministic.
 */
export function classifyDangerousCommand(command: string): DangerousCommandVerdict {
  if (typeof command !== "string" || command.length === 0) {
    return SAFE;
  }
  for (const [pattern, reason] of RULES) {
    if (pattern.test(command)) {
      return { dangerous: true, reason };
    }
  }
  return SAFE;
}
