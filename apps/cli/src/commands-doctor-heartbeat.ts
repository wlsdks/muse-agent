/**
 * `muse doctor` surfacing for the proactive-tick liveness heartbeat (DS-8).
 *
 * Kept in its own file (not `commands-doctor-checks.ts`) so it composes the
 * heartbeat primitive without editing the crowded shared checks module. The
 * diagnosis itself is the deterministic `classifyProactiveHeartbeat` in
 * `@muse/stores`; here we only read the two mark files and map the verdict to
 * a doctor line.
 *
 * Severity mapping is deliberately conservative — a box that never runs the
 * proactive daemon has NO heartbeat and must not be nagged:
 *   - healthy / unknown (never ran) → ok
 *   - dead (was running, now stopped) / failing (running but every tick
 *     throws) → warn (actionable, not a hard failure)
 */

import {
  classifyProactiveHeartbeat,
  defaultProactiveHeartbeatDir,
  readProactiveHeartbeat,
  type ProactiveHeartbeat,
  type ProactiveHeartbeatStatus,
  type ProactiveHeartbeatThresholds
} from "@muse/stores";

import type { LocalCheck } from "./commands-doctor-checks.js";

export function heartbeatStatusToCheckStatus(status: ProactiveHeartbeatStatus): LocalCheck["status"] {
  switch (status) {
    case "dead":
    case "failing":
      return "warn";
    // "unknown" means the daemon has never left a heartbeat on this box — which, since
    // the daemon does not auto-start, is the DEFAULT state of every install. Mapping it
    // to "ok" turned "I have no idea whether this ever ran" into a green tick, and the
    // green tick is why nobody noticed that decay, skill merge, consolidation,
    // reflection and pattern detection had never run for anyone. Not knowing is not
    // health; it is the absence of evidence, and here the absence is the finding.
    case "unknown":
      return "warn";
    case "healthy":
      return "ok";
  }
}

/** Pure: turn an observed heartbeat + clock into a doctor line. */
export function proactiveHeartbeatCheck(
  heartbeat: ProactiveHeartbeat,
  thresholds: ProactiveHeartbeatThresholds
): LocalCheck {
  const verdict = classifyProactiveHeartbeat(heartbeat, thresholds);
  return {
    detail: verdict.detail,
    name: "proactive heartbeat",
    status: heartbeatStatusToCheckStatus(verdict.status)
  };
}

/** IO wrapper: read the mark files from the sidecar-derived dir and diagnose. */
export async function readProactiveHeartbeatCheck(
  env: Record<string, string | undefined> = process.env,
  now: () => Date = () => new Date()
): Promise<LocalCheck> {
  const dir = defaultProactiveHeartbeatDir(env);
  const heartbeat = await readProactiveHeartbeat(dir).catch(() => ({}) as ProactiveHeartbeat);
  return proactiveHeartbeatCheck(heartbeat, { nowMs: now().getTime() });
}
