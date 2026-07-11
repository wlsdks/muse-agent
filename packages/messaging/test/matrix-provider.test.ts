import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendInbound } from "../src/inbox-store.js";
import { MatrixProvider } from "../src/matrix-provider.js";
import { readMatrixSince, writeMatrixSince } from "../src/matrix-since-store.js";

const HOMESERVER = "https://hs.test";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly auth: string | null;
  readonly body: unknown;
}

function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response,
  calls: RecordedCall[]
): typeof globalThis.fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method: init?.method ?? "GET",
      url: String(url)
    });
    return handler(String(url), init);
  }) as unknown as typeof globalThis.fetch;
}

function syncBody(options: {
  readonly nextBatch: string;
  readonly events?: readonly Record<string, unknown>[];
  readonly roomId?: string;
}): unknown {
  return {
    next_batch: options.nextBatch,
    rooms: options.events
      ? { join: { [options.roomId ?? "!room:hs.test"]: { timeline: { events: options.events } } } }
      : {}
  };
}

function messageEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: { body: "hello muse", msgtype: "m.text" },
    event_id: "$evt1",
    origin_server_ts: 1_751_000_000_000,
    sender: "@jinan:hs.test",
    type: "m.room.message",
    ...overrides
  };
}

describe("MatrixProvider.send", () => {
  it("PUTs an m.text event to the room-send endpoint with Bearer auth and unique txnIds", async () => {
    const calls: RecordedCall[] = [];
    const provider = new MatrixProvider({
      accessToken: "syt_secret",
      fetch: recordingFetch(() => jsonResponse(200, { event_id: "$sent" }), calls),
      homeserverUrl: HOMESERVER
    });

    const receipt = await provider.send({ destination: "!room:hs.test", text: "hi" });
    await provider.send({ destination: "!room:hs.test", text: "again" });

    expect(receipt).toMatchObject({ destination: "!room:hs.test", messageId: "$sent", providerId: "matrix" });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.auth).toBe("Bearer syt_secret");
    expect(calls[0]!.url).toContain(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent("!room:hs.test")}/send/m.room.message/`);
    expect(calls[0]!.body).toEqual({ body: "hi", msgtype: "m.text" });
    const txn = (url: string) => url.slice(url.lastIndexOf("/") + 1);
    expect(txn(calls[0]!.url)).not.toBe(txn(calls[1]!.url));
  });

  it("surfaces a Matrix error body as a MessagingProviderError", async () => {
    const provider = new MatrixProvider({
      accessToken: "t",
      fetch: (async () => jsonResponse(403, { errcode: "M_FORBIDDEN", error: "not in room" })) as unknown as typeof globalThis.fetch,
      homeserverUrl: HOMESERVER
    });
    await expect(provider.send({ destination: "!room:hs.test", text: "hi" })).rejects.toThrow(/not in room/u);
  });
});

describe("MatrixProvider.pollUpdates", () => {
  it("long-polls /sync with timeout=<ms>, persists next_batch, and passes since= on the next call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-poll-"));
    const sinceFile = join(dir, "since.json");
    const calls: RecordedCall[] = [];
    let syncCount = 0;
    const provider = new MatrixProvider({
      accessToken: "t",
      fetch: recordingFetch((url) => {
        if (url.includes("/account/whoami")) {
          return jsonResponse(200, { user_id: "@muse:hs.test" });
        }
        syncCount += 1;
        return jsonResponse(200, syncBody({ events: [messageEvent()], nextBatch: `s${syncCount.toString()}` }));
      }, calls),
      homeserverUrl: HOMESERVER,
      sinceFile
    });

    await provider.pollUpdates({ longPollSeconds: 25 });
    expect(await readMatrixSince(sinceFile)).toBe("s1");

    await provider.pollUpdates({ longPollSeconds: 25 });
    const syncUrls = calls.filter((call) => call.url.includes("/sync")).map((call) => call.url);
    expect(syncUrls[0]).toContain("timeout=25000");
    expect(syncUrls[0]).not.toContain("since=");
    expect(syncUrls[1]).toContain("since=s1");
    expect(await readMatrixSince(sinceFile)).toBe("s2");
  });

  it("maps m.room.message text events to InboundMessage {source, sender, text}", async () => {
    const provider = new MatrixProvider({
      accessToken: "t",
      fetch: recordingFetch((url) => {
        if (url.includes("/account/whoami")) {
          return jsonResponse(200, { user_id: "@muse:hs.test" });
        }
        return jsonResponse(200, syncBody({ events: [messageEvent()], nextBatch: "s1", roomId: "!chat:hs.test" }));
      }, []),
      homeserverUrl: HOMESERVER
    });

    const inbound = await provider.pollUpdates();
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      messageId: "$evt1",
      providerId: "matrix",
      sender: "@jinan:hs.test",
      source: "!chat:hs.test",
      text: "hello muse"
    });
    expect(inbound[0]!.receivedAtIso).toBe(new Date(1_751_000_000_000).toISOString());
  });

  it("filters out the bot's own messages via whoami and caches the user_id", async () => {
    const calls: RecordedCall[] = [];
    const provider = new MatrixProvider({
      accessToken: "t",
      fetch: recordingFetch((url) => {
        if (url.includes("/account/whoami")) {
          return jsonResponse(200, { user_id: "@muse:hs.test" });
        }
        return jsonResponse(200, syncBody({
          events: [
            messageEvent({ event_id: "$own", sender: "@muse:hs.test" }),
            messageEvent({ event_id: "$theirs", sender: "@jinan:hs.test" })
          ],
          nextBatch: "s1"
        }));
      }, calls),
      homeserverUrl: HOMESERVER
    });

    const first = await provider.pollUpdates();
    const second = await provider.pollUpdates();
    expect(first.map((m) => m.messageId)).toEqual(["$theirs"]);
    expect(second.map((m) => m.messageId)).toEqual(["$theirs"]);
    expect(calls.filter((call) => call.url.includes("/account/whoami"))).toHaveLength(1);
  });

  it("skips non-message and non-text events", async () => {
    const provider = new MatrixProvider({
      accessToken: "t",
      fetch: recordingFetch((url) => {
        if (url.includes("/account/whoami")) {
          return jsonResponse(200, { user_id: "@muse:hs.test" });
        }
        return jsonResponse(200, syncBody({
          events: [
            { content: {}, event_id: "$member", sender: "@x:hs.test", type: "m.room.member" },
            { content: { msgtype: "m.image", url: "mxc://x" }, event_id: "$img", sender: "@x:hs.test", type: "m.room.message" },
            messageEvent({ event_id: "$text" })
          ],
          nextBatch: "s1"
        }));
      }, []),
      homeserverUrl: HOMESERVER
    });

    const inbound = await provider.pollUpdates();
    expect(inbound.map((m) => m.messageId)).toEqual(["$text"]);
  });

  it("surfaces a sync failure as a MessagingProviderError and leaves the since token unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-poll-"));
    const sinceFile = join(dir, "since.json");
    await writeMatrixSince(sinceFile, "s0");
    const provider = new MatrixProvider({
      accessToken: "t",
      fetch: (async () => jsonResponse(401, { errcode: "M_UNKNOWN_TOKEN", error: "Invalid access token" })) as unknown as typeof globalThis.fetch,
      homeserverUrl: HOMESERVER,
      sinceFile
    });
    await expect(provider.pollUpdates()).rejects.toThrow(/Invalid access token/u);
    expect(await readMatrixSince(sinceFile)).toBe("s0");
  });
});

describe("MatrixProvider.sendTyping", () => {
  it("PUTs typing:true with a 5s timeout to the whoami-resolved user's typing endpoint", async () => {
    const calls: RecordedCall[] = [];
    const provider = new MatrixProvider({
      accessToken: "t",
      fetch: recordingFetch((url) => {
        if (url.includes("/account/whoami")) {
          return jsonResponse(200, { user_id: "@muse:hs.test" });
        }
        return jsonResponse(200, {});
      }, calls),
      homeserverUrl: HOMESERVER
    });

    await provider.sendTyping("!room:hs.test");
    const typing = calls.find((call) => call.url.includes("/typing/"));
    expect(typing?.method).toBe("PUT");
    expect(typing?.url).toBe(
      `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent("!room:hs.test")}/typing/${encodeURIComponent("@muse:hs.test")}`
    );
    expect(typing?.body).toEqual({ timeout: 5000, typing: true });
  });

  it("surfaces an upstream typing failure as a provider error", async () => {
    const provider = new MatrixProvider({
      accessToken: "t",
      fetch: recordingFetch((url) => {
        if (url.includes("/account/whoami")) {
          return jsonResponse(200, { user_id: "@muse:hs.test" });
        }
        return jsonResponse(429, { errcode: "M_LIMIT_EXCEEDED", error: "Too Many Requests" });
      }, []),
      homeserverUrl: HOMESERVER
    });
    await expect(provider.sendTyping("!room:hs.test")).rejects.toThrow(/Too Many Requests/u);
  });
});

describe("MatrixProvider.fetchInbound", () => {
  it("reads the persisted inbox file when configured instead of hitting /sync", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-inbox-"));
    const inboxFile = join(dir, "inbox.json");
    await appendInbound(inboxFile, {
      messageId: "$evt9",
      providerId: "matrix",
      receivedAtIso: "2026-07-11T00:00:00.000Z",
      sender: "@jinan:hs.test",
      source: "!room:hs.test",
      text: "from the inbox"
    });
    const provider = new MatrixProvider({
      accessToken: "t",
      fetch: (async () => {
        throw new Error("must not hit the network");
      }) as unknown as typeof globalThis.fetch,
      homeserverUrl: HOMESERVER,
      inboxFile
    });

    const inbound = await provider.fetchInbound();
    expect(inbound.map((m) => m.messageId)).toEqual(["$evt9"]);
  });
});

describe("MatrixProvider.describe", () => {
  it("declares the plaintext-rooms-only surface", async () => {
    const provider = new MatrixProvider({ accessToken: "t", homeserverUrl: `${HOMESERVER}/` });
    const info = provider.describe();
    expect(info.id).toBe("matrix");
    expect(info.displayName).toBe("Matrix");
    expect(info.description).toMatch(/plaintext/iu);
  });
});
