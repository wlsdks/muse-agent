/**
 * Per-IP token bucket for the chat endpoints.
 *
 * Basic DoS hardening: a scripted abuser pointed at a running
 * muse-api dev server could burn the user's provider quota in
 * seconds. Caps each IP at N requests per minute (default 60).
 *
 * Implementation: in-memory `Map<ip, bucket>` with refill-on-read
 * semantics. No external dependency, no Redis. Buckets are evicted
 * when stale to keep the map bounded — a fresh IP gets a fresh
 * bucket on first request.
 *
 * Limits apply to the three chat entry points only:
 *   POST /chat, /api/chat, /chat/stream, /api/chat/stream,
 *   /api/chat/multipart
 *
 * Other routes (today / history / admin / etc.) stay unlimited —
 * personal-JARVIS use, single-user box, the chat path is the only
 * one that triggers a paid upstream call.
 */

import { finiteOr } from "@muse/shared";

export interface ChatRateLimiterOptions {
  /** Requests allowed per `windowMs`. Default 60. */
  readonly capacity?: number;
  /** Sliding window length in milliseconds. Default 60_000. */
  readonly windowMs?: number;
  /** Injectable clock for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
  /** When > 0, drop bucket entries older than this many ms. Default 5 min. */
  readonly evictAfterMs?: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Seconds the client should wait before retrying. Set on `allowed: false`. */
  readonly retryAfterSeconds?: number;
}


export class ChatRateLimiter {
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly evictAfterMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: ChatRateLimiterOptions = {}) {
    // `??` does NOT catch NaN/Infinity. A non-finite option would
    // make `tokens >= 1` (NaN) always false → the limiter denies
    // EVERY request after the first (a self-DoS of /api/chat), or
    // a NaN refill rate poisons the bucket. Guard finiteness so a
    // corrupt option falls back to the safe default, not a broken
    // limiter (same posture as the agent-runtime tool-loop clamp).
    this.capacity = Math.max(1, finiteOr(options.capacity, 60));
    this.windowMs = Math.max(1_000, finiteOr(options.windowMs, 60_000));
    this.evictAfterMs = Math.max(this.windowMs, finiteOr(options.evictAfterMs, 5 * 60_000));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Charge one request against the bucket for `ip`. Returns
   * `{ allowed: true }` when there was a token to spend, or
   * `{ allowed: false, retryAfterSeconds }` when the bucket is empty.
   */
  consume(ip: string): RateLimitVerdict {
    const now = this.now();
    this.evictStale(now);
    const existing = this.buckets.get(ip);
    if (!existing) {
      this.buckets.set(ip, { lastRefillMs: now, tokens: this.capacity - 1 });
      return { allowed: true };
    }
    // Refill: tokens regenerate linearly at capacity per windowMs.
    const elapsed = now - existing.lastRefillMs;
    if (elapsed > 0) {
      const refill = (elapsed / this.windowMs) * this.capacity;
      existing.tokens = Math.min(this.capacity, existing.tokens + refill);
      existing.lastRefillMs = now;
    }
    if (existing.tokens >= 1) {
      existing.tokens -= 1;
      return { allowed: true };
    }
    // Out of tokens. Compute the wait for the next whole token.
    const msUntilOne = ((1 - existing.tokens) * this.windowMs) / this.capacity;
    const retryAfterSeconds = Math.max(1, Math.ceil(msUntilOne / 1_000));
    return { allowed: false, retryAfterSeconds };
  }

  /** Test/admin: drop every bucket. */
  reset(): void {
    this.buckets.clear();
  }

  private evictStale(now: number): void {
    for (const [ip, bucket] of this.buckets) {
      if (now - bucket.lastRefillMs > this.evictAfterMs) {
        this.buckets.delete(ip);
      }
    }
  }
}

/**
 * Extract a client identifier from a Fastify request.
 *
 * When the request carries an authenticated identity
 * (i.e. `attachAuthIdentity` wrote `request.auth.userId` during
 * the `onRequest` hook), key on that so two users sharing a
 * corporate egress IP each get independent buckets. Anonymous
 * requests still fall back to `request.ip`; only as a last
 * resort do we return `"unknown"`. Prefixing the key with
 * `user:` / `ip:` keeps the two namespaces from accidentally
 * colliding in the in-memory map.
 */
export function clientKeyFromRequest(request: { ip?: string; auth?: { userId?: string } }): string {
  const userId = typeof request.auth?.userId === "string" && request.auth.userId.length > 0
    ? request.auth.userId
    : undefined;
  if (userId) {
    return `user:${userId}`;
  }
  const ip = typeof request.ip === "string" && request.ip.length > 0 ? request.ip : undefined;
  return ip ? `ip:${ip}` : "ip:unknown";
}
