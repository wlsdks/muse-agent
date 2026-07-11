import { describe, expect, it } from "vitest";

import { verifyMessagingToken } from "./token-verify.js";

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const { body, status } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("verifyMessagingToken", () => {
  it("telegram: getMe ok:true resolves the bot username", async () => {
    const calls: string[] = [];
    const result = await verifyMessagingToken("telegram", "123:abc", {
      fetchImpl: fakeFetch((url) => {
        calls.push(url);
        return { body: { ok: true, result: { username: "muse_bot" } }, status: 200 };
      })
    });
    expect(result).toEqual({ account: "@muse_bot", ok: true });
    expect(calls[0]).toBe("https://api.telegram.org/bot123:abc/getMe");
  });

  it("telegram: 401 unauthorized fails closed with the API's description", async () => {
    const result = await verifyMessagingToken("telegram", "bad", {
      fetchImpl: fakeFetch(() => ({ body: { description: "Unauthorized", ok: false }, status: 401 }))
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Unauthorized");
    }
  });

  it("discord: users/@me sends the Bot authorization header and resolves the username", async () => {
    let auth = "";
    const result = await verifyMessagingToken("discord", "dtok", {
      fetchImpl: fakeFetch((url, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        expect(url).toBe("https://discord.com/api/v10/users/@me");
        return { body: { username: "muse" }, status: 200 };
      })
    });
    expect(result).toEqual({ account: "muse", ok: true });
    expect(auth).toBe("Bot dtok");
  });

  it("slack: auth.test ok:false fails closed even on HTTP 200", async () => {
    const result = await verifyMessagingToken("slack", "xoxb-bad", {
      fetchImpl: fakeFetch(() => ({ body: { error: "invalid_auth", ok: false }, status: 200 }))
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("invalid_auth");
    }
  });

  it("line: bot/info resolves the basicId", async () => {
    const result = await verifyMessagingToken("line", "ltok", {
      fetchImpl: fakeFetch((url) => {
        expect(url).toBe("https://api.line.me/v2/bot/info");
        return { body: { basicId: "@muse", displayName: "Muse" }, status: 200 };
      })
    });
    expect(result).toEqual({ account: "@muse", ok: true });
  });

  it("matrix: whoami sends the Bearer header against the given homeserver and resolves user_id", async () => {
    let auth = "";
    const result = await verifyMessagingToken("matrix", "syt_tok", {
      fetchImpl: fakeFetch((url, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        expect(url).toBe("https://hs.test/_matrix/client/v3/account/whoami");
        return { body: { user_id: "@muse:hs.test" }, status: 200 };
      }),
      homeserverUrl: "https://hs.test/"
    });
    expect(result).toEqual({ account: "@muse:hs.test", ok: true });
    expect(auth).toBe("Bearer syt_tok");
  });

  it("matrix: fails closed without a homeserver URL and never fetches", async () => {
    const result = await verifyMessagingToken("matrix", "syt_tok", {
      fetchImpl: fakeFetch(() => {
        throw new Error("must not fetch");
      })
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("homeserver");
    }
  });

  it("matrix: 401 unknown token fails closed with the API's error message", async () => {
    const result = await verifyMessagingToken("matrix", "bad", {
      fetchImpl: fakeFetch(() => ({ body: { errcode: "M_UNKNOWN_TOKEN", error: "Invalid access token" }, status: 401 })),
      homeserverUrl: "https://hs.test"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Invalid access token");
    }
  });

  it("unknown provider fails closed without any network call", async () => {
    const result = await verifyMessagingToken("smoke-signals", "t", {
      fetchImpl: fakeFetch(() => {
        throw new Error("must not fetch");
      })
    });
    expect(result.ok).toBe(false);
  });

  it("network failure fails closed instead of throwing", async () => {
    const result = await verifyMessagingToken("telegram", "t", {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ECONNREFUSED");
    }
  });
});
