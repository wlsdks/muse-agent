import { createHmac } from "node:crypto";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readInbox } from "@muse/messaging";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { lineWebhookPlugin } from "../src/messaging-webhooks-routes.js";

function buildLineWebhookServer(channelSecret: string, inboxFile: string): ReturnType<typeof Fastify> {
  const server = Fastify({ logger: false });
  void server.register(lineWebhookPlugin, { channelSecret, inboxFile });
  return server;
}

function sign(channelSecret: string, body: string): string {
  return createHmac("sha256", channelSecret).update(body).digest("base64");
}

describe("POST /api/messaging/webhooks/line", () => {
  it("accepts a valid signature and persists text events to the inbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-line-webhook-"));
    const inboxFile = join(dir, "line-inbox.json");
    const secret = "channel-secret-test";
    const server = buildLineWebhookServer(secret, inboxFile);

    const payload = {
      destination: "U-bot",
      events: [
        {
          message: { id: "msg-1", text: "hello", type: "text" },
          source: { type: "user", userId: "U-stark" },
          timestamp: 1700000000000,
          type: "message"
        },
        // Non-text events are ignored (e.g. sticker / follow / etc).
        { type: "follow", source: { userId: "U-stark" }, timestamp: 1700000060000 }
      ]
    };
    const body = JSON.stringify(payload);
    const reply = await server.inject({
      headers: {
        "content-type": "application/json",
        "x-line-signature": sign(secret, body)
      },
      method: "POST",
      payload: body,
      url: "/api/messaging/webhooks/line"
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ events: 2, stored: 1 });

    const stored = await readInbox(inboxFile);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      messageId: "msg-1",
      providerId: "line",
      receivedAtIso: "2023-11-14T22:13:20.000Z",
      sender: "U-stark",
      source: "U-stark",
      text: "hello"
    });
    await server.close();
  });

  it("rejects with 401 when X-Line-Signature is missing or wrong", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-line-webhook-bad-"));
    const inboxFile = join(dir, "line-inbox.json");
    const secret = "channel-secret-test";
    const server = buildLineWebhookServer(secret, inboxFile);

    const body = JSON.stringify({ destination: "U-bot", events: [] });

    // Missing header.
    const noSig = await server.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: body,
      url: "/api/messaging/webhooks/line"
    });
    expect(noSig.statusCode).toBe(401);
    expect(noSig.json()).toMatchObject({ code: "MESSAGING_WEBHOOK_UNSIGNED" });

    // Wrong signature — signed with a different secret.
    const wrongSig = await server.inject({
      headers: {
        "content-type": "application/json",
        "x-line-signature": sign("different-secret", body)
      },
      method: "POST",
      payload: body,
      url: "/api/messaging/webhooks/line"
    });
    expect(wrongSig.statusCode).toBe(401);
    expect(wrongSig.json()).toMatchObject({ code: "MESSAGING_WEBHOOK_BAD_SIGNATURE" });

    // A wrong-LENGTH / non-base64 forged signature must still be a
    // clean 401 — `timingSafeEqual` throws on unequal byte length,
    // so without the length-guard this path would 500 (a DoS
    // vector: an attacker probing with junk crashes the endpoint).
    for (const junk of ["abc", "x".repeat(200), "not base64 at all"]) {
      const badLen = await server.inject({
        headers: { "content-type": "application/json", "x-line-signature": junk },
        method: "POST",
        payload: body,
        url: "/api/messaging/webhooks/line"
      });
      expect(badLen.statusCode).toBe(401);
      expect(badLen.json()).toMatchObject({ code: "MESSAGING_WEBHOOK_BAD_SIGNATURE" });
    }

    // No file written.
    expect(existsSync(inboxFile)).toBe(false);
    await server.close();
  });

  it("uses the userId/groupId/roomId fallback chain for `source`; skips events with no source id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-line-webhook-source-"));
    const inboxFile = join(dir, "line-inbox.json");
    const secret = "channel-secret-source";
    const server = buildLineWebhookServer(secret, inboxFile);

    const payload = {
      events: [
        // group-only — should map to source=groupId, no `sender`.
        {
          message: { id: "g-1", text: "hi from group", type: "text" },
          source: { groupId: "G-team" },
          timestamp: 1700000000000,
          type: "message"
        },
        // No source id at all → skipped.
        {
          message: { id: "ghost", text: "x", type: "text" },
          source: {},
          timestamp: 1700000000000,
          type: "message"
        }
      ]
    };
    const body = JSON.stringify(payload);
    const reply = await server.inject({
      headers: {
        "content-type": "application/json",
        "x-line-signature": sign(secret, body)
      },
      method: "POST",
      payload: body,
      url: "/api/messaging/webhooks/line"
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ events: 2, stored: 1 });

    const stored = await readInbox(inboxFile);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ messageId: "g-1", source: "G-team", text: "hi from group" });
    expect(stored[0]?.sender).toBeUndefined();
    await server.close();
  });
});

describe("buildServer LINE webhook gating", () => {
  // Unlike the sibling tests (which register only the lightweight
  // lineWebhookPlugin), this one builds the FULL app via buildServer to verify
  // its conditional route wiring — its cold module import alone exceeds 20s under
  // full-suite parallel load on a saturated machine (observed flake). It runs in
  // ~1-2s in isolation, so a wide timeout costs the normal case nothing.
  it("does not register the route when MUSE_LINE_CHANNEL_SECRET is unset", async () => {
    // buildServer reads process.env directly; ensure the secret is absent.
    const prev = process.env.MUSE_LINE_CHANNEL_SECRET;
    delete process.env.MUSE_LINE_CHANNEL_SECRET;
    try {
      const { buildServer } = await import("../src/server.js");
      const server = buildServer({ logger: false, lineInboxFile: "/tmp/should-not-be-touched.json" });
      const reply = await server.inject({ method: "POST", url: "/api/messaging/webhooks/line", payload: "{}" });
      expect(reply.statusCode).toBe(404);
      await server.close();
    } finally {
      if (prev !== undefined) { process.env.MUSE_LINE_CHANNEL_SECRET = prev; }
    }
  }, 60_000);
});
