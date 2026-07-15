import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChatRateLimiter } from "../src/chat-rate-limiter.js";
import { buildServer } from "../src/server.js";

describe("POST /api/chat per-IP rate limit", () => {
  it("allows N requests then returns 429 with Retry-After once the bucket is empty", async () => {
    // 5-req cap inside a 60s window keeps the test small + deterministic.
    let frozenNow = 1_700_000_000_000;
    const limiter = new ChatRateLimiter({ capacity: 5, now: () => frozenNow, windowMs: 60_000 });
    const server = buildServer({ chatRateLimiter: limiter, logger: false });

    // First 5 → 503 because no agent runtime is wired, but they ALL pass
    // the rate-limit gate (the 429 path is what we're testing). 6th hits
    // the limiter and gets 429 + Retry-After.
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 6; i += 1) {
      const reply = await server.inject({
        method: "POST",
        url: "/api/chat",
        payload: { message: "hi" }
      });
      statuses.push(reply.statusCode);
      if (reply.statusCode === 429) {
        retryAfter = reply.headers["retry-after"] as string | null;
        const body = reply.json() as { error?: string; retryAfterSeconds?: number };
        expect(body.error).toMatch(/rate limit exceeded/u);
        expect(body.retryAfterSeconds).toBeGreaterThan(0);
      }
    }

    // 5 pass the rate-limit gate (status whatever — 503/200 — but NOT 429),
    // 1 hits the bucket-empty path.
    const blocked = statuses.filter((s) => s === 429).length;
    expect(blocked).toBe(1);
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);

    // After advancing time enough to refill ≥1 token, the next call
    // again passes the rate-limit gate.
    frozenNow += 60_000; // full refill window elapses
    const sixth = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "hi" }
    });
    expect(sixth.statusCode).not.toBe(429);
  });

  it("applies the limit independently per IP", async () => {
    const limiter = new ChatRateLimiter({ capacity: 2, windowMs: 60_000 });
    const server = buildServer({ chatRateLimiter: limiter, logger: false });

    // Burn IP A's bucket.
    for (let i = 0; i < 3; i += 1) {
      await server.inject({
        method: "POST",
        url: "/api/chat",
        payload: { message: "x" },
        remoteAddress: "10.0.0.1"
      });
    }
    // IP A is now blocked.
    const blockedA = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "x" },
      remoteAddress: "10.0.0.1"
    });
    expect(blockedA.statusCode).toBe(429);

    // IP B still has its own bucket and is not affected.
    const allowedB = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "x" },
      remoteAddress: "10.0.0.2"
    });
    expect(allowedB.statusCode).not.toBe(429);
  });

  it("ChatRateLimiter.consume reports a Retry-After matching the refill rate", () => {
    const now = 0;
    const limiter = new ChatRateLimiter({ capacity: 2, now: () => now, windowMs: 60_000 });
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(true);
    const denied = limiter.consume("a");
    expect(denied.allowed).toBe(false);
    // 2 tokens / 60s = 1 token every 30s — retry-after rounded up to 30.
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(31);
  });

  it("a non-finite capacity/windowMs falls back to the default instead of breaking the limiter", () => {
    const now = 0;
    // Pre-fix: capacity NaN ⇒ tokens NaN ⇒ `NaN >= 1` false ⇒ every
    // request after the first is DENIED (a self-DoS of /api/chat).
    const nanCap = new ChatRateLimiter({ capacity: Number.NaN, now: () => now, windowMs: 60_000 });
    for (let i = 0; i < 30; i += 1) {
      expect(nanCap.consume("a").allowed).toBe(true); // default 60 ⇒ all allowed
    }
    // Infinity is also non-finite ⇒ default (still a real bound).
    const infCap = new ChatRateLimiter({ capacity: Number.POSITIVE_INFINITY, now: () => now, windowMs: 60_000 });
    for (let i = 0; i < 60; i += 1) {
      expect(infCap.consume("b").allowed).toBe(true);
    }
    expect(infCap.consume("b").allowed).toBe(false); // bounded at default 60, not unlimited
    // A NaN windowMs must not poison the refill math.
    const nanWin = new ChatRateLimiter({ capacity: 2, now: () => now, windowMs: Number.NaN });
    expect(nanWin.consume("c").allowed).toBe(true);
    expect(nanWin.consume("c").allowed).toBe(true);
    expect(nanWin.consume("c").allowed).toBe(false); // bounded normally
  });

  it("clientKeyFromRequest prefers authenticated userId over IP", async () => {
    const { clientKeyFromRequest } = await import("../src/chat-rate-limiter.js");
    // Authenticated → user-namespaced.
    expect(
      clientKeyFromRequest({ ip: "10.0.0.1", auth: { userId: "alice" } })
    ).toBe("user:alice");
    // Anonymous → ip-namespaced.
    expect(
      clientKeyFromRequest({ ip: "10.0.0.1" })
    ).toBe("ip:10.0.0.1");
    // Anonymous + no ip → fallback bucket (still namespaced as IP).
    expect(clientKeyFromRequest({})).toBe("ip:unknown");
    // Empty auth.userId falls back to ip.
    expect(
      clientKeyFromRequest({ ip: "10.0.0.2", auth: { userId: "" } })
    ).toBe("ip:10.0.0.2");
    // The two namespaces don't collide — a user named "10.0.0.1"
    // gets a different bucket than the IP 10.0.0.1.
    expect(clientKeyFromRequest({ auth: { userId: "10.0.0.1" } }))
      .not.toBe(clientKeyFromRequest({ ip: "10.0.0.1" }));
  });

  describe("POST /api/chat/approvals/:id/deny runs through the same limiter as approve", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "muse-chat-deny-rate-"));
    });

    afterEach(async () => {
      await rm(dir, { force: true, recursive: true });
    });

    it("429 + Retry-After once the shared bucket is exhausted, for both approve and deny", async () => {
      const limiter = new ChatRateLimiter({ capacity: 1, windowMs: 60_000 });
      const server = buildServer({
        chatRateLimiter: limiter,
        env: {
          MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
          MUSE_PENDING_APPROVALS_FILE: join(dir, "pending-approvals.json")
        },
        logger: false
      });

      // Burns the single shared token on the approve route.
      const approve = await server.inject({ method: "POST", url: "/api/chat/approvals/x1/approve" });
      expect(approve.statusCode).not.toBe(429);

      // Deny hits the SAME limiter bucket and is now blocked.
      const deny = await server.inject({ method: "POST", url: "/api/chat/approvals/x1/deny" });
      expect(deny.statusCode).toBe(429);
      expect(deny.headers["retry-after"]).toBeDefined();
      const body = deny.json() as { error?: string; retryAfterSeconds?: number };
      expect(body.error).toMatch(/rate limit exceeded/u);
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  it("two authenticated users sharing one IP get independent buckets", () => {
    const limiter = new ChatRateLimiter({ capacity: 2, windowMs: 60_000 });
    // Alice burns her bucket.
    expect(limiter.consume("user:alice").allowed).toBe(true);
    expect(limiter.consume("user:alice").allowed).toBe(true);
    expect(limiter.consume("user:alice").allowed).toBe(false);
    // Bob (same IP in production, different userId) still has his own.
    expect(limiter.consume("user:bob").allowed).toBe(true);
    expect(limiter.consume("user:bob").allowed).toBe(true);
    expect(limiter.consume("user:bob").allowed).toBe(false);
    // Anonymous IP bucket from the same egress is also independent.
    expect(limiter.consume("ip:10.0.0.1").allowed).toBe(true);
  });
});
