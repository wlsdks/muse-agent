/**
 * Matrix ingestion daemon — the `/sync` counterpart of
 * `telegram-poll-tick.ts`'s long-poll mode.
 *
 * A continuous self-scheduling loop: each `provider.pollUpdates`
 * call is HELD by the homeserver for up to `longPollSeconds` and
 * returns the moment an event arrives — near-real-time delivery
 * with no webhook. `pollUpdates` persists the `next_batch` token
 * itself, so each tick advances the stream rather than re-syncing.
 * The loop re-launches immediately after each sync (`relaunchDelayMs`
 * breather) and backs off to `intervalMs` after an error so a dead
 * network or revoked token can't hot-loop.
 *
 * Off by default. `server.ts` activates it only when
 * `MUSE_MATRIX_POLL_ENABLED` is set, the messaging registry has the
 * `matrix` provider, and `inboxFile` is configured.
 */

import { appendInbound, type MatrixProvider } from "@muse/messaging";

export interface MatrixSyncOptions {
  readonly provider: MatrixProvider;
  readonly inboxFile: string;
  /** Error backoff between failed syncs (default 30s, clamped [5s, 1h]). */
  readonly intervalMs?: number;
  readonly fetchLimit?: number;
  /** Seconds the homeserver holds each /sync (default 25). */
  readonly longPollSeconds?: number;
  /** Breather between successful syncs (default 250ms; tests shrink it). */
  readonly relaunchDelayMs?: number;
  /** Fires after a sync that ingested >0 messages — lets the reply daemon run immediately. */
  readonly onIngested?: (count: number) => void;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
}

export interface MatrixSyncHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60_000;
const DEFAULT_RELAUNCH_DELAY_MS = 250;
const DEFAULT_LONG_POLL_SECONDS = 25;

export function startMatrixSyncTick(options: MatrixSyncOptions): MatrixSyncHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const longPollSeconds = options.longPollSeconds ?? DEFAULT_LONG_POLL_SECONDS;
  const relaunchDelayMs = options.relaunchDelayMs ?? DEFAULT_RELAUNCH_DELAY_MS;
  let syncing = false;

  const tickOnce = async (): Promise<boolean> => {
    if (syncing) {
      return false;
    }
    syncing = true;
    try {
      const inbound = await options.provider.pollUpdates({
        ...(options.fetchLimit !== undefined ? { limit: options.fetchLimit } : {}),
        ...(longPollSeconds > 0 ? { longPollSeconds } : {})
      });
      if (inbound.length === 0) {
        return true;
      }
      for (const message of inbound) {
        await appendInbound(options.inboxFile, message);
      }
      options.logger?.(`matrix-sync: ingested ${inbound.length.toString()} message(s)`);
      options.onIngested?.(inbound.length);
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      options.errorLogger?.(`matrix-sync: ${message}`);
      return false;
    } finally {
      syncing = false;
    }
  };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    const ok = await tickOnce();
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void loop();
    }, ok ? relaunchDelayMs : intervalMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  };
  void loop();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
    tickOnce: async () => {
      await tickOnce();
    }
  };
}

function clampInterval(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}
