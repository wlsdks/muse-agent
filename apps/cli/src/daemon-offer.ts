/**
 * The ONE-TIME offer to run `muse daemon --install`, printed from `muse
 * chat` / `muse ask` on startup.
 *
 * Decay, skill merge, consolidation, reflection, and pattern detection are
 * ALL daemon-only (see `daemon-selflearn-ticks.ts` + `daemon-watch-ticks.ts`)
 * and `muse daemon` never auto-starts — so half of a self-learning-enabled
 * install silently never runs unless the user separately launches the
 * daemon. This offers the fix exactly once and never installs anything
 * itself: every precedent (Raycast — off until first opened; Ollama —
 * launch the app, then it backgrounds) refuses to plant a KeepAlive
 * LaunchAgent without a user action, and this repo follows the same rule.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parseBoolean } from "@muse/autoconfigure";
import { classifyProactiveHeartbeat, defaultProactiveHeartbeatDir, readProactiveHeartbeat } from "@muse/stores";
import { isRecord } from "@muse/shared";

import { resolveLaunchAgentFile } from "./commands-daemon-launchagent.js";

export const DAEMON_INSTALL_OFFER_LINE =
  "Muse learns from your corrections in the background (decay, skill merge, reflection) — but only while `muse daemon` is running. That same resident process starts at every login, restarts if it exits, and also delivers proactive notices, syncs email, and — only if you've opted in — reads Chrome browsing history and watches your active window title. Run `muse daemon --install` once to keep it running after you close this session. (won't ask again)";

/** True inside a vitest worker — the ambient signal, never the caller-supplied `env`. */
function isRunningUnderVitest(): boolean {
  return (process.env.VITEST ?? "").trim().length > 0 || process.env.VITEST_WORKER_ID !== undefined;
}

export function resolveDaemonOfferFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.MUSE_DAEMON_OFFER_FILE?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const home = env.HOME?.trim()?.length ? env.HOME.trim() : homedir();
  return join(home, ".muse", "daemon-offer-shown.json");
}

function hasAlreadyOffered(file: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) && parsed.offered === true;
  } catch {
    return false;
  }
}

// Best-effort: a failed write just means the offer might reappear next
// session, never that the current command should fail.
function markOffered(file: string, now: () => Date): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ at: now().toISOString(), offered: true })}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

export interface MaybeOfferDaemonInstallDeps {
  readonly env: NodeJS.ProcessEnv;
  /** Where the printed line goes — callers use `io.stderr` so `--json` output stays clean. */
  readonly print: (line: string) => void;
  /** Test seam — override the resolved plist path instead of `resolveLaunchAgentFile(env)`. */
  readonly plistFile?: string;
  /** Test seam — override the resolved offer-marker path instead of `resolveDaemonOfferFile(env)`. */
  readonly offerFile?: string;
  /** Test seam — override the heartbeat directory instead of `defaultProactiveHeartbeatDir(env)`. */
  readonly heartbeatDir?: string;
  /** Test seam — injectable clock for the persisted offer timestamp AND the heartbeat-freshness check. */
  readonly now?: () => Date;
  /**
   * Test seam — override whether the destination is an interactive TTY;
   * defaults to `process.stderr.isTTY`. The one-time marker is persisted
   * ONLY when true — a piped/scripted run (`muse ask … 2>/dev/null`) still
   * prints, but doesn't silently burn the single lifetime offer on a user
   * who never saw it.
   */
  readonly isTTY?: boolean;
}

/**
 * Print the offer at most once, and only when it would change something:
 *   - self-learning must be enabled (default true, MUSE_SELFLEARN_ENABLED),
 *   - the daemon must not already be HEALTHY per `classifyProactiveHeartbeat`
 *     (alive + fired both fresh) — a stale mark (the daemon died months ago,
 *     or the mark came from a single foreground `muse proactive` run that
 *     never repeated) does NOT suppress the offer; only a currently-healthy
 *     resident loop does,
 *   - no LaunchAgent plist may already be installed,
 *   - and this offer must not have been shown before.
 * Returns whether it printed, for callers/tests that want to assert on it.
 *
 * Safe by construction under vitest: when running inside a test AND the
 * caller passed none of `offerFile`/`heartbeatDir`/`plistFile` explicitly
 * (i.e. it would resolve against the ambient, possibly-real, `env.HOME`),
 * this refuses outright rather than risk writing into a contributor's real
 * `~/.muse` and burning their one-time offer — `program.ts` / `commands-
 * ask.ts` call this with the ambient `process.env` on every turn, so a
 * future test exercising the full `ask`/`chat` command without stubbing
 * HOME must not silently touch the real filesystem.
 */
export async function maybeOfferDaemonInstall(deps: MaybeOfferDaemonInstallDeps): Promise<boolean> {
  if (isRunningUnderVitest() && deps.offerFile === undefined && deps.heartbeatDir === undefined && deps.plistFile === undefined) {
    return false;
  }

  const { env } = deps;
  if (!parseBoolean(env.MUSE_SELFLEARN_ENABLED, true)) return false;

  const offerFile = deps.offerFile ?? resolveDaemonOfferFile(env);
  if (hasAlreadyOffered(offerFile)) return false;

  const plistFile = deps.plistFile ?? resolveLaunchAgentFile(env);
  if (existsSync(plistFile)) return false;

  const now = deps.now ?? (() => new Date());
  const heartbeatDir = deps.heartbeatDir ?? defaultProactiveHeartbeatDir(env);
  const heartbeat = await readProactiveHeartbeat(heartbeatDir);
  const verdict = classifyProactiveHeartbeat(heartbeat, { nowMs: now().getTime() });
  if (verdict.status === "healthy") return false;

  deps.print(DAEMON_INSTALL_OFFER_LINE);
  const isTTY = deps.isTTY ?? process.stderr.isTTY === true;
  if (isTTY) {
    markOffered(offerFile, now);
  }
  return true;
}
