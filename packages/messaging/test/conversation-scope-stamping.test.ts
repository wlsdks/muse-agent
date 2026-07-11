import { describe, expect, it } from "vitest";

import { DiscordProvider } from "../src/discord-provider.js";
import { MatrixProvider } from "../src/matrix-provider.js";
import { SlackProvider } from "../src/slack-provider.js";
import { TelegramProvider } from "../src/telegram-provider.js";

// Conversation-scope capability profiles (P7-3): each provider stamps
// `InboundMessage.scope` from whatever DM/group signal its payload shape
// carries, so downstream (pairing, memory isolation, risky-tool approval)
// can treat a group/shared chat differently from a 1:1. A provider that
// genuinely can't tell leaves `scope` absent — `effectiveScope` treats
// absent as "shared" (fail-close), never silently as "direct".

function fakeJsonResponse(body: unknown, init: { readonly status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: init.status ?? 200
  });
}

describe("TelegramProvider scope stamping", () => {
  it("stamps direct for a positive chat.id (private 1:1)", async () => {
    const provider = new TelegramProvider({
      fetch: async () =>
        fakeJsonResponse({
          ok: true,
          result: [
            {
              message: { chat: { id: 999, type: "private" }, date: 1700000000, message_id: 1, text: "hi" },
              update_id: 1
            }
          ]
        }),
      token: "TOKEN"
    });
    const inbound = await provider.fetchInbound();
    expect(inbound[0]?.scope).toBe("direct");
  });

  it("stamps shared for a negative chat.id (group/supergroup)", async () => {
    const provider = new TelegramProvider({
      fetch: async () =>
        fakeJsonResponse({
          ok: true,
          result: [
            {
              message: { chat: { id: -100123, type: "supergroup" }, date: 1700000000, message_id: 2, text: "hi all" },
              update_id: 2
            }
          ]
        }),
      token: "TOKEN"
    });
    const inbound = await provider.fetchInbound();
    expect(inbound[0]?.scope).toBe("shared");
  });

  it("trusts an explicit chat.type over the id sign when both are present", async () => {
    const provider = new TelegramProvider({
      fetch: async () =>
        fakeJsonResponse({
          ok: true,
          result: [
            {
              message: { chat: { id: 42, type: "private" }, date: 1700000000, message_id: 3, text: "hi" },
              update_id: 3
            }
          ]
        }),
      token: "TOKEN"
    });
    const inbound = await provider.fetchInbound();
    expect(inbound[0]?.scope).toBe("direct");
  });
});

describe("SlackProvider scope stamping", () => {
  it("stamps direct for a channel id starting with D (DM)", async () => {
    const provider = new SlackProvider({
      fetch: async () =>
        fakeJsonResponse({
          messages: [{ text: "hi", ts: "1700000000.000100", type: "message", user: "U1" }],
          ok: true
        }),
      token: "xoxb-test"
    });
    const inbound = await provider.fetchInbound({ source: "D0123ABCD" });
    expect(inbound[0]?.scope).toBe("direct");
  });

  it("stamps shared for a public (C) or private (G) channel id", async () => {
    const provider = new SlackProvider({
      fetch: async () =>
        fakeJsonResponse({
          messages: [{ text: "hi", ts: "1700000000.000100", type: "message", user: "U1" }],
          ok: true
        }),
      token: "xoxb-test"
    });
    const publicChannel = await provider.fetchInbound({ source: "C0123ABCD" });
    expect(publicChannel[0]?.scope).toBe("shared");
    const privateChannel = await provider.fetchInbound({ source: "G0123ABCD" });
    expect(privateChannel[0]?.scope).toBe("shared");
  });
});

describe("MatrixProvider scope stamping", () => {
  function syncBody(options: {
    readonly nextBatch: string;
    readonly joinedMemberCount?: number;
    readonly roomId?: string;
  }): unknown {
    const roomId = options.roomId ?? "!room:hs.test";
    return {
      next_batch: options.nextBatch,
      rooms: {
        join: {
          [roomId]: {
            summary: options.joinedMemberCount !== undefined
              ? { "m.joined_member_count": options.joinedMemberCount }
              : undefined,
            timeline: {
              events: [
                {
                  content: { body: "hello", msgtype: "m.text" },
                  event_id: "$evt1",
                  origin_server_ts: 1_751_000_000_000,
                  sender: "@jinan:hs.test",
                  type: "m.room.message"
                }
              ]
            }
          }
        }
      }
    };
  }

  function recordingFetch(handler: (url: string) => Response): typeof globalThis.fetch {
    return (async (url: string | URL | Request) => {
      const asString = String(url);
      if (asString.includes("/account/whoami")) {
        return new Response(JSON.stringify({ user_id: "@muse:hs.test" }), { status: 200 });
      }
      return handler(asString);
    }) as unknown as typeof globalThis.fetch;
  }

  it("stamps direct when joined_member_count <= 2", async () => {
    const provider = new MatrixProvider({
      accessToken: "t",
      fetch: recordingFetch(() => fakeJsonResponse(syncBody({ joinedMemberCount: 2, nextBatch: "s1" }))),
      homeserverUrl: "https://hs.test"
    });
    const inbound = await provider.pollUpdates();
    expect(inbound[0]?.scope).toBe("direct");
  });

  it("stamps shared when joined_member_count > 2", async () => {
    const provider = new MatrixProvider({
      accessToken: "t",
      fetch: recordingFetch(() => fakeJsonResponse(syncBody({ joinedMemberCount: 5, nextBatch: "s1" }))),
      homeserverUrl: "https://hs.test"
    });
    const inbound = await provider.pollUpdates();
    expect(inbound[0]?.scope).toBe("shared");
  });

  it("leaves scope absent when the homeserver omits the room summary (unknown, never direct)", async () => {
    const provider = new MatrixProvider({
      accessToken: "t",
      fetch: recordingFetch(() => fakeJsonResponse(syncBody({ nextBatch: "s1" }))),
      homeserverUrl: "https://hs.test"
    });
    const inbound = await provider.pollUpdates();
    expect(inbound[0]?.scope).toBeUndefined();
  });
});

describe("DiscordProvider scope stamping", () => {
  it("leaves scope absent — the REST channel-messages endpoint carries no DM/guild signal", async () => {
    const provider = new DiscordProvider({
      fetch: async () =>
        fakeJsonResponse([
          { author: { username: "stark" }, channel_id: "ch-9", content: "hi", id: "1", timestamp: "2026-07-11T00:00:00.000Z" }
        ]),
      token: "TOKEN"
    });
    const inbound = await provider.fetchInbound({ source: "ch-9" });
    expect(inbound[0]?.scope).toBeUndefined();
  });
});
