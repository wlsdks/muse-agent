/**
 * Liveness heartbeat for the proactive / scheduler tick loop (DS-8).
 *
 * A background ticker has two failure modes that look identical from the
 * outside — "nothing is firing":
 *   1. the ticker THREAD/PROCESS is dead (crashed, never started), and
 *   2. the ticker is alive and looping but EVERY tick throws (a bad
 *      config, an unreadable store, a provider outage), so it never
 *      completes a clean pass.
 *
 * A single "last ran" marker can't tell these apart. So we record TWO
 * signals (the pattern in hermes' cron ticker):
 *   - `alive`  — touched at the START of every tick, before any work.
 *   - `fired`  — touched at the END of a tick that returned WITHOUT
 *                throwing (a clean pass).
 *
 * `classifyProactiveHeartbeat` then reads both:
 *   - alive fresh + fired fresh   → healthy
 *   - alive fresh + fired stale   → running but failing every tick
 *   - alive stale (or missing)    → the ticker isn't running
 *
 * Writes are best-effort and MUST NEVER throw into the tick loop — a
 * heartbeat write failure can't be allowed to break the actual work.
 * Reads degrade to "unknown", never throw.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "./atomic-file-store.js";

/**
 * `"daemon-loop"` is a THIRD, independent signal (R2-1): the proactive
 * tick's `alive`/`fired` pair only reflects `runDueProactiveNotices`
 * specifically. `daemon-loop` is touched once per `runTick` round in
 * `muse daemon` — i.e. the whole tick composition (scheduler, reminders,
 * followups, …), not just the proactive sub-tick — so a caller that only
 * cares "is the daemon process actually looping" (e.g. `muse scheduler
 * add`'s liveness warning, `muse status`) doesn't have to reach through an
 * unrelated package's internal tick to answer that.
 */
export type ProactiveHeartbeatSignal = "alive" | "fired" | "daemon-loop";

export interface ProactiveHeartbeatMark {
  /** ISO timestamp the signal was recorded. */
  readonly at: string;
  /** PID of the process that recorded it (diagnostic — which ticker). */
  readonly pid: number;
}

export interface ProactiveHeartbeat {
  readonly alive?: ProactiveHeartbeatMark;
  readonly fired?: ProactiveHeartbeatMark;
  readonly daemonLoop?: ProactiveHeartbeatMark;
}

const ALIVE_FILE = "proactive-heartbeat-alive.json";
const FIRED_FILE = "proactive-heartbeat-fired.json";
const DAEMON_LOOP_FILE = "proactive-heartbeat-daemon-loop.json";

function fileFor(dir: string, signal: ProactiveHeartbeatSignal): string {
  if (signal === "alive") return join(dir, ALIVE_FILE);
  if (signal === "fired") return join(dir, FIRED_FILE);
  return join(dir, DAEMON_LOOP_FILE);
}

/**
 * Where the heartbeat files live. Co-located with the proactive sidecar
 * (default `~/.muse`) so the loop and the `muse doctor` reader agree
 * without extra wiring. Honors `MUSE_PROACTIVE_SIDECAR_FILE` so an
 * operator who relocated the sidecar keeps the heartbeat next to it.
 */
export function defaultProactiveHeartbeatDir(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const sidecar = env.MUSE_PROACTIVE_SIDECAR_FILE?.trim();
  if (sidecar && sidecar.length > 0) {
    return dirname(sidecar);
  }
  return join(homedir(), ".muse");
}

/**
 * Record a heartbeat signal. Best-effort: any failure (unwritable dir,
 * full disk) is swallowed and reported via the boolean return so the
 * caller can log it, but it NEVER throws — a dead heartbeat must not
 * take down the tick it is meant to observe.
 */
export async function recordProactiveHeartbeat(
  dir: string,
  signal: ProactiveHeartbeatSignal,
  now: () => Date = () => new Date(),
  pid: number = process.pid
): Promise<boolean> {
  try {
    const mark: ProactiveHeartbeatMark = { at: now().toISOString(), pid };
    await atomicWriteFile(fileFor(dir, signal), `${JSON.stringify(mark)}\n`);
    return true;
  } catch {
    return false;
  }
}

async function readMark(path: string): Promise<ProactiveHeartbeatMark | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProactiveHeartbeatMark>;
    if (typeof parsed.at === "string" && typeof parsed.pid === "number") {
      return { at: parsed.at, pid: parsed.pid };
    }
  } catch {
    /* corrupt / half-written → treat as absent */
  }
  return undefined;
}

/** Read all heartbeat marks. Missing / corrupt files degrade to undefined, never throw. */
export async function readProactiveHeartbeat(dir: string): Promise<ProactiveHeartbeat> {
  const [alive, fired, daemonLoop] = await Promise.all([
    readMark(fileFor(dir, "alive")),
    readMark(fileFor(dir, "fired")),
    readMark(fileFor(dir, "daemon-loop"))
  ]);
  return { ...(alive ? { alive } : {}), ...(fired ? { fired } : {}), ...(daemonLoop ? { daemonLoop } : {}) };
}

export type ProactiveHeartbeatStatus = "healthy" | "failing" | "dead" | "unknown";

export interface ProactiveHeartbeatVerdict {
  readonly status: ProactiveHeartbeatStatus;
  readonly detail: string;
  /** Age in ms of the alive mark, or undefined when absent/unparseable. */
  readonly aliveAgeMs?: number;
  /** Age in ms of the fired mark, or undefined when absent/unparseable. */
  readonly firedAgeMs?: number;
}

export interface ProactiveHeartbeatThresholds {
  readonly nowMs: number;
  /** Alive older than this ⇒ the ticker is presumed not running. Default 5 min. */
  readonly aliveStaleMs?: number;
  /** Fired older than this (while alive is fresh) ⇒ failing every tick. Default 15 min. */
  readonly firedStaleMs?: number;
}

const DEFAULT_ALIVE_STALE_MS = 5 * 60_000;
const DEFAULT_FIRED_STALE_MS = 15 * 60_000;

function markAgeMs(mark: ProactiveHeartbeatMark | undefined, nowMs: number): number | undefined {
  if (!mark) return undefined;
  const t = Date.parse(mark.at);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, nowMs - t);
}

function humanAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000).toString()}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000).toString()}m ago`;
  return `${Math.round(ms / 3_600_000).toString()}h ago`;
}

/**
 * Diagnose the ticker from its two heartbeat marks. Deterministic + pure —
 * the doctor/status surface injects `nowMs` and the observed marks.
 *
 * - No alive mark at all  → "unknown" (older build, or the ticker has
 *   never run on this box) — NOT asserted dead, since a missing file is
 *   also the pre-first-run state.
 * - Alive stale/unparseable → "dead": the loop stopped touching alive.
 * - Alive fresh, fired stale/absent → "failing": looping but every tick
 *   throws before the clean-pass mark.
 * - Both fresh → "healthy".
 */
export function classifyProactiveHeartbeat(
  heartbeat: ProactiveHeartbeat,
  thresholds: ProactiveHeartbeatThresholds
): ProactiveHeartbeatVerdict {
  const aliveStaleMs = Number.isFinite(thresholds.aliveStaleMs) ? thresholds.aliveStaleMs! : DEFAULT_ALIVE_STALE_MS;
  const firedStaleMs = Number.isFinite(thresholds.firedStaleMs) ? thresholds.firedStaleMs! : DEFAULT_FIRED_STALE_MS;
  const aliveAgeMs = markAgeMs(heartbeat.alive, thresholds.nowMs);
  const firedAgeMs = markAgeMs(heartbeat.fired, thresholds.nowMs);

  const ages = {
    ...(aliveAgeMs !== undefined ? { aliveAgeMs } : {}),
    ...(firedAgeMs !== undefined ? { firedAgeMs } : {})
  };

  if (aliveAgeMs === undefined) {
    return {
      ...ages,
      detail: "no proactive-tick heartbeat yet — the daemon may not have run on this box",
      status: "unknown"
    };
  }
  if (aliveAgeMs > aliveStaleMs) {
    return {
      ...ages,
      detail: `proactive ticker looks stopped — last tick started ${humanAge(aliveAgeMs)} (> ${humanAge(aliveStaleMs)} threshold); check the daemon / \`muse daemon status\``,
      status: "dead"
    };
  }
  if (firedAgeMs === undefined || firedAgeMs > firedStaleMs) {
    const last = firedAgeMs === undefined ? "never completed a clean tick" : `last clean tick ${humanAge(firedAgeMs)}`;
    return {
      ...ages,
      detail: `proactive ticker is RUNNING (last tick ${humanAge(aliveAgeMs)}) but ${last} — every tick is failing; check recent logs`,
      status: "failing"
    };
  }
  return {
    ...ages,
    detail: `proactive ticker healthy — last tick ${humanAge(aliveAgeMs)}, last clean pass ${humanAge(firedAgeMs)}`,
    status: "healthy"
  };
}

export type DaemonLoopHeartbeatStatus = "alive" | "stale" | "unknown";

export interface DaemonLoopHeartbeatVerdict {
  readonly status: DaemonLoopHeartbeatStatus;
  readonly detail: string;
  /** Age in ms of the daemon-loop mark, or undefined when absent/unparseable. */
  readonly ageMs?: number;
}

export interface DaemonLoopHeartbeatThresholds {
  readonly nowMs: number;
  /**
   * Older than this ⇒ the daemon loop is presumed not running. Callers
   * derive this from their own default tick interval (there is no
   * store-owned default here — `muse daemon`'s interval is a CLI concern);
   * the R2-1 callers use 3x the daemon's default tick interval.
   */
  readonly staleMs: number;
}

/**
 * Diagnose the daemon's per-round `daemon-loop` mark. Simpler than
 * `classifyProactiveHeartbeat` on purpose: this signal has no `fired`
 * counterpart to distinguish "running but failing" from "dead" — it only
 * answers "has ANY tick round started recently" — so the verdict is a
 * plain three-state alive/stale/unknown, sharing the same age + humanAge
 * primitives as `classifyProactiveHeartbeat`.
 */
export function classifyDaemonLoopHeartbeat(
  heartbeat: ProactiveHeartbeat,
  thresholds: DaemonLoopHeartbeatThresholds
): DaemonLoopHeartbeatVerdict {
  const ageMs = markAgeMs(heartbeat.daemonLoop, thresholds.nowMs);
  if (ageMs === undefined) {
    return { detail: "no daemon-loop heartbeat yet — `muse daemon` may never have run on this box", status: "unknown" };
  }
  if (ageMs > thresholds.staleMs) {
    return {
      ageMs,
      detail: `daemon loop looks stopped — last round started ${humanAge(ageMs)} (> ${humanAge(thresholds.staleMs)} threshold)`,
      status: "stale"
    };
  }
  return { ageMs, detail: `daemon loop alive — last round ${humanAge(ageMs)}`, status: "alive" };
}
