/**
 * The stale-daemon counterpart for the learn queue: a queued correction
 * that will never distill until SOMETHING drains it — either `muse daemon`
 * (one per tick) or `muse playbook drain` (all of them, right now). Silent
 * when the queue is empty OR a live daemon is already draining it; a single
 * actionable stderr line otherwise. Read-only, fail-soft — a corrupt/missing
 * file never breaks `muse ask`.
 */
import { classifyDaemonLoopHeartbeat, defaultProactiveHeartbeatDir, readPendingLearnEvents, readProactiveHeartbeat, resolveLearnQueueFile } from "@muse/stores";

import { DEFAULT_DAEMON_INTERVAL_MS } from "./commands-daemon-loop.js";

const LEARN_QUEUE_NOTICE_STALE_MS = 3 * DEFAULT_DAEMON_INTERVAL_MS;

export interface LearnQueuePendingNoticeOptions {
  /** Test seam — override the heartbeat dir instead of `defaultProactiveHeartbeatDir(env)`. */
  readonly heartbeatDir?: string;
  /** Test seam — injectable clock. */
  readonly now?: () => Date;
}

/**
 * Returns the one-line notice, or `undefined` when there is nothing to say
 * (empty queue, or a daemon that is actually alive and will drain it soon).
 */
export async function buildLearnQueuePendingNotice(
  env: NodeJS.ProcessEnv,
  options: LearnQueuePendingNoticeOptions = {}
): Promise<string | undefined> {
  const queueFile = resolveLearnQueueFile(env);
  const pending = await readPendingLearnEvents(queueFile);
  if (pending.length === 0) {
    return undefined;
  }
  const heartbeatDir = options.heartbeatDir ?? defaultProactiveHeartbeatDir(env);
  const now = options.now ?? (() => new Date());
  const heartbeat = await readProactiveHeartbeat(heartbeatDir);
  const verdict = classifyDaemonLoopHeartbeat(heartbeat, { nowMs: now().getTime(), staleMs: LEARN_QUEUE_NOTICE_STALE_MS });
  if (verdict.status === "alive") {
    return undefined;
  }
  const count = pending.length;
  return `muse: ${count.toString()} correction${count === 1 ? "" : "s"} queued to learn from — \`muse playbook drain\` to learn now, \`muse daemon --install\` for always-on.\n`;
}
