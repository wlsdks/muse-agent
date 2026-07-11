/**
 * on-exit event-driven schedules (openclaw parity) — "when this process/command
 * finishes, fire the job" as a deterministic alternative to a cron expression.
 *
 * Design: the scheduler SPAWNS the watched command itself (the "gateway-supervised
 * watcher" model) rather than attaching to an externally-running process. That
 * keeps detection deterministic (Node's `child.on("exit", …)` is authoritative)
 * and avoids PID-reuse ambiguity. Spawning an arbitrary command is `execute`-class
 * risk, so every watch is gated by the same `classifyDangerousCommand` guard the
 * Rust-runner (`run_command`) and the background-process spawner
 * (`@muse/stores/background-process-spawn.ts`) already use — no new blocklist.
 *
 * One-shot: `OnExitScheduler.arm` resolves once, records completion in the
 * store, and does not re-watch. Crash-safety: an armed watch is a durable
 * record (`OnExitWatchStore`) written BEFORE the child is spawned. A watched
 * child dies with its parent process — nothing survives a scheduler restart to
 * re-attach to — so `reconcileOnStartup` fires every still-armed record with
 * status "watcher-lost" (fail-close visibility) rather than silently
 * re-spawning a command whose original trigger condition may no longer hold.
 * This is the deliberately simpler of the two honest options the slice
 * considered (re-arm was rejected — see commit body).
 */

import { spawn as nodeSpawn } from "node:child_process";

import { classifyDangerousCommand } from "@muse/tools";

import { SchedulerValidationError } from "./scheduler-errors.js";
import type { Awaitable } from "./index.js";

export const minOnExitPollMs = 100;
export const maxOnExitPollMs = 60_000;
export const minOnExitTimeoutMs = 1_000;
export const maxOnExitTimeoutMs = 3_600_000;
export const defaultOnExitKillGraceMs = 5_000;

export interface OnExitTrigger {
  readonly kind: "on-exit";
  readonly command: string;
  /**
   * Defense-in-depth liveness poll. Node's child `exit` event is the primary
   * and normally-sufficient detection path; when set, the watcher ALSO polls
   * process liveness at this interval so a missed/undelivered `exit` event
   * still resolves the watch instead of hanging forever.
   */
  readonly pollMs?: number;
  /** Kill the child and fire with status "timed-out" if it hasn't exited by then. */
  readonly timeoutMs?: number;
}

export function validateOnExitTrigger(trigger: OnExitTrigger): void {
  if (trigger.kind !== "on-exit") {
    throw new SchedulerValidationError(`Expected an on-exit trigger, got kind '${String((trigger as { kind?: unknown }).kind)}'`);
  }

  if (!trigger.command?.trim()) {
    throw new SchedulerValidationError("on-exit schedule requires a non-blank command");
  }

  if (trigger.pollMs !== undefined && !isBoundedInteger(trigger.pollMs, minOnExitPollMs, maxOnExitPollMs)) {
    throw new SchedulerValidationError(`on-exit pollMs must be an integer between ${minOnExitPollMs} and ${maxOnExitPollMs}`);
  }

  if (trigger.timeoutMs !== undefined && !isBoundedInteger(trigger.timeoutMs, minOnExitTimeoutMs, maxOnExitTimeoutMs)) {
    throw new SchedulerValidationError(`on-exit timeoutMs must be an integer between ${minOnExitTimeoutMs} and ${maxOnExitTimeoutMs}`);
  }
}

function isBoundedInteger(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max;
}

export type OnExitWatchStatus = "exited" | "timed-out" | "watcher-lost";

export interface OnExitWatchOutcome {
  readonly status: OnExitWatchStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
}

export interface OnExitSpawnedChild {
  readonly pid: number;
  kill(signal: NodeJS.Signals): void;
  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface OnExitSpawner {
  spawn(command: string): OnExitSpawnedChild;
}

export function createNodeOnExitSpawner(): OnExitSpawner {
  return {
    spawn(command) {
      const child = nodeSpawn(command, { shell: true, stdio: "ignore" });

      return {
        kill(signal) {
          try {
            child.kill(signal);
          } catch {
            /* already dead */
          }
        },
        onExit(listener) {
          child.on("exit", (code, signal) => listener(code, signal));
        },
        pid: child.pid ?? -1
      };
    }
  };
}

export interface OnExitWatcherOptions {
  readonly spawner?: OnExitSpawner;
  readonly now?: () => Date;
  readonly killGraceMs?: number;
  /** Injected for the pollMs liveness fail-safe; defaults to a real `process.kill(pid, 0)` probe. */
  readonly isAlive?: (pid: number) => boolean;
}

export class OnExitWatcher {
  private readonly spawner: OnExitSpawner;
  private readonly now: () => Date;
  private readonly killGraceMs: number;
  private readonly isAlive: (pid: number) => boolean;

  constructor(options: OnExitWatcherOptions = {}) {
    this.spawner = options.spawner ?? createNodeOnExitSpawner();
    this.now = options.now ?? (() => new Date());
    this.killGraceMs = options.killGraceMs ?? defaultOnExitKillGraceMs;
    this.isAlive = options.isAlive ?? defaultIsAlive;
  }

  watch(trigger: OnExitTrigger): Promise<OnExitWatchOutcome> {
    validateOnExitTrigger(trigger);

    const danger = classifyDangerousCommand(trigger.command);
    if (danger.dangerous) {
      throw new SchedulerValidationError(`on-exit command refused: ${danger.reason} — irreversible, blocked in code`);
    }

    const startedAt = this.now();
    const child = this.spawner.spawn(trigger.command);
    let timedOut = false;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    return new Promise((resolve) => {
      const clearTimers = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killTimer) clearTimeout(killTimer);
        if (pollTimer) clearInterval(pollTimer);
      };

      const finish = (status: OnExitWatchStatus, exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve({ durationMs: this.now().getTime() - startedAt.getTime(), exitCode, signal, status });
      };

      child.onExit((exitCode, signal) => {
        finish(timedOut ? "timed-out" : "exited", exitCode, signal);
      });

      if (trigger.timeoutMs) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            child.kill("SIGKILL");
          }, this.killGraceMs);
        }, trigger.timeoutMs);
      }

      if (trigger.pollMs) {
        pollTimer = setInterval(() => {
          if (!settled && child.pid >= 0 && !this.isAlive(child.pid)) {
            finish(timedOut ? "timed-out" : "exited", null, null);
          }
        }, trigger.pollMs);
      }
    });
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface OnExitArmedRecord {
  readonly jobId: string;
  readonly trigger: OnExitTrigger;
  readonly armedAt: Date;
}

export interface OnExitWatchStore {
  markArmed(jobId: string, trigger: OnExitTrigger, armedAt: Date): Awaitable<void>;
  markCompleted(jobId: string, outcome: OnExitWatchOutcome): Awaitable<void>;
  findArmed(jobId: string): Awaitable<OnExitArmedRecord | undefined>;
  listArmed(): Awaitable<readonly OnExitArmedRecord[]>;
}

export class InMemoryOnExitWatchStore implements OnExitWatchStore {
  private readonly armed = new Map<string, OnExitArmedRecord>();

  markArmed(jobId: string, trigger: OnExitTrigger, armedAt: Date): void {
    this.armed.set(jobId, { armedAt, jobId, trigger });
  }

  markCompleted(jobId: string): void {
    this.armed.delete(jobId);
  }

  findArmed(jobId: string): OnExitArmedRecord | undefined {
    return this.armed.get(jobId);
  }

  listArmed(): readonly OnExitArmedRecord[] {
    return [...this.armed.values()];
  }
}

export type OnExitFireHandler = (jobId: string, outcome: OnExitWatchOutcome) => Awaitable<void>;

export interface OnExitSchedulerOptions {
  readonly watcher?: OnExitWatcher;
  readonly store: OnExitWatchStore;
  readonly now?: () => Date;
}

export class OnExitScheduler {
  private readonly watcher: OnExitWatcher;
  private readonly store: OnExitWatchStore;
  private readonly now: () => Date;
  private readonly armedJobIds = new Set<string>();

  constructor(options: OnExitSchedulerOptions) {
    this.watcher = options.watcher ?? new OnExitWatcher();
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Arm a one-shot on-exit watch: spawns `trigger.command`, and when it exits
   * (or times out), fires `onFire` exactly once through whatever "normal
   * job-execution pipeline" the caller composes here — e.g.
   * `(jobId, outcome) => dynamicScheduler.trigger(jobId)` with the outcome
   * surfaced to the job via its own context. Not rescheduled after firing.
   */
  async arm(jobId: string, trigger: OnExitTrigger, onFire: OnExitFireHandler): Promise<OnExitWatchOutcome> {
    validateOnExitTrigger(trigger);

    if (this.armedJobIds.has(jobId)) {
      throw new SchedulerValidationError(`on-exit job '${jobId}' already has a watcher armed`);
    }

    this.armedJobIds.add(jobId);
    await this.store.markArmed(jobId, trigger, this.now());

    try {
      const outcome = await this.watcher.watch(trigger);
      await this.store.markCompleted(jobId, outcome);
      await onFire(jobId, outcome);
      return outcome;
    } finally {
      this.armedJobIds.delete(jobId);
    }
  }

  /**
   * Startup crash-safety pass: fire every still-armed record as
   * "watcher-lost" (see module doc for why re-arming was rejected) and clear
   * it from the store. Returns the reconciled job ids.
   */
  async reconcileOnStartup(onFire: OnExitFireHandler): Promise<readonly string[]> {
    const armed = await this.store.listArmed();
    const reconciled: string[] = [];

    for (const record of armed) {
      const outcome: OnExitWatchOutcome = {
        durationMs: Math.max(0, this.now().getTime() - record.armedAt.getTime()),
        exitCode: null,
        signal: null,
        status: "watcher-lost"
      };

      await this.store.markCompleted(record.jobId, outcome);
      await onFire(record.jobId, outcome);
      reconciled.push(record.jobId);
    }

    return reconciled;
  }
}
