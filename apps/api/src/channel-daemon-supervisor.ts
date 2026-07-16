/**
 * Live registry of channel-daemon handles (telegram poll, matrix sync,
 * inbound reply, …). The settings/integrations surfaces read RUNNING
 * state from here — a live handle, never an env flag — so the UI can't
 * claim a daemon is on while nothing is actually polling. Also the
 * seam that lets a UI connect hot-start a daemon after boot and lets
 * a reconnect replace the previous handle without orphaning it.
 */

interface StoppableHandle {
  readonly stop: () => void;
}

export interface ChannelDaemonStatus {
  readonly running: boolean;
  readonly lastIngestAtIso?: string;
  readonly lastIngestCount?: number;
  readonly lastError?: string;
  readonly lastErrorAtIso?: string;
}

export interface ChannelDaemonSupervisor {
  /** Register a live handle under a stable name; replaces (and stops) any previous one. */
  adopt(name: string, handle: StoppableHandle): void;
  isRunning(name: string): boolean;
  stop(name: string): void;
  /** Terminal server-shutdown operation; later registrations are stopped. */
  stopAll(): void;
  noteIngest(name: string, count: number): void;
  noteError(name: string, message: string): void;
  status(): Readonly<Record<string, ChannelDaemonStatus>>;
}

interface DaemonState {
  handle?: StoppableHandle;
  lastIngestAtIso?: string;
  lastIngestCount?: number;
  lastError?: string;
  lastErrorAtIso?: string;
}

export function createChannelDaemonSupervisor(): ChannelDaemonSupervisor {
  const daemons = new Map<string, DaemonState>();
  const replacingCandidates = new Map<string, StoppableHandle>();
  const stoppingHandles = new Set<StoppableHandle>();
  let closed = false;
  let stoppingAll = false;

  const state = (name: string): DaemonState => {
    const existing = daemons.get(name);
    if (existing) {
      return existing;
    }
    const fresh: DaemonState = {};
    daemons.set(name, fresh);
    return fresh;
  };

  const safelyStop = (handle: StoppableHandle | undefined): void => {
    if (!handle || stoppingHandles.has(handle)) return;

    stoppingHandles.add(handle);
    try {
      handle.stop();
    } catch {
      // A failed cleanup must not leave the replacement or stopped state
      // reporting the old daemon as live. The caller records operational
      // errors separately through noteError.
    } finally {
      stoppingHandles.delete(handle);
    }
  };

  return {
    adopt(name, handle) {
      if (daemons.get(name)?.handle === handle) return;

      if (closed || stoppingAll) {
        safelyStop(handle);
        return;
      }

      const replacingCandidate = replacingCandidates.get(name);
      if (replacingCandidate) {
        if (replacingCandidate !== handle) safelyStop(handle);
        return;
      }

      const entry = state(name);
      const previous = entry.handle;

      replacingCandidates.set(name, handle);
      entry.handle = undefined;
      try {
        safelyStop(previous);
      } finally {
        replacingCandidates.delete(name);
      }

      if (closed || stoppingAll) {
        safelyStop(handle);
        return;
      }

      entry.handle = handle;
    },
    isRunning(name) {
      return daemons.get(name)?.handle !== undefined;
    },
    noteError(name, message) {
      const entry = state(name);
      entry.lastError = redactSecretsInText(message).slice(0, 2_000);
      entry.lastErrorAtIso = new Date().toISOString();
    },
    noteIngest(name, count) {
      const entry = state(name);
      entry.lastIngestAtIso = new Date().toISOString();
      entry.lastIngestCount = Number.isSafeInteger(count) && count >= 0 ? count : 0;
    },
    status() {
      return Object.fromEntries(
        [...daemons.entries()].map(([name, entry]) => [
          name,
          {
            running: entry.handle !== undefined,
            ...(entry.lastIngestAtIso ? { lastIngestAtIso: entry.lastIngestAtIso } : {}),
            ...(entry.lastIngestCount !== undefined ? { lastIngestCount: entry.lastIngestCount } : {}),
            ...(entry.lastError ? { lastError: entry.lastError } : {}),
            ...(entry.lastErrorAtIso ? { lastErrorAtIso: entry.lastErrorAtIso } : {})
          }
        ])
      );
    },
    stop(name) {
      const entry = daemons.get(name);
      if (entry) {
        const handle = entry.handle;
        entry.handle = undefined;
        safelyStop(handle);
      }
    },
    stopAll() {
      if (closed || stoppingAll) return;

      closed = true;
      stoppingAll = true;
      try {
        for (const entry of daemons.values()) {
          const handle = entry.handle;
          entry.handle = undefined;
          safelyStop(handle);
        }
      } finally {
        stoppingAll = false;
      }
    }
  };
}
import { redactSecretsInText } from "@muse/shared";
