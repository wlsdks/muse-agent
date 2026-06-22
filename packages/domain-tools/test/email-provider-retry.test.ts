import { describe, expect, it, vi } from "vitest";

import { GmailEmailProvider } from "../src/email-provider.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
function status(code: number): Response {
  return new Response("", { status: code });
}

const listOk = () => json({ messages: [{ id: "m1" }] });
const msgOk = () => json({ labelIds: ["INBOX", "UNREAD"], payload: { headers: [{ name: "From", value: "a@b.com" }, { name: "Subject", value: "Hello" }] }, snippet: "hi there" });

function sequenceFetch(factories: Array<() => Response>) {
  let index = 0;
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    const factory = factories[Math.min(index, factories.length - 1)]!;
    index += 1;
    return factory();
  }) as unknown as typeof globalThis.fetch;
  return { calls: () => calls, fetchImpl };
}

const noWait = { baseDelayMs: 0, sleep: async () => {} };

describe("GmailEmailProvider — read path is retry-hardened", () => {
  it("listRecent recovers from a transient 503 on the inbox read", async () => {
    // 503 on the list call, then the list 200, then the message detail 200.
    const { calls, fetchImpl } = sequenceFetch([() => status(503), listOk, msgOk]);
    const provider = new GmailEmailProvider("token", fetchImpl, noWait);
    const messages = await provider.listRecent(5);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.subject).toBe("Hello");
    expect(calls()).toBe(3); // 503 + list retry + message detail
  });

  it("still surfaces a clear error once read retries are exhausted", async () => {
    const { calls, fetchImpl } = sequenceFetch([() => status(503)]);
    const provider = new GmailEmailProvider("token", fetchImpl, noWait);
    await expect(provider.listRecent(5)).rejects.toThrow("Gmail API 503");
    expect(calls()).toBe(3);
  });

  it("a single message's malformed body does NOT drop the whole inbox", async () => {
    // List has 3 ids; message #2 returns a 200 with a garbage (non-JSON)
    // body — the kind of HTML error interstitial Gmail/proxies occasionally
    // serve. The other two messages must still come back.
    const msg = (subject: string) =>
      json({ labelIds: ["INBOX"], payload: { headers: [{ name: "Subject", value: subject }] }, snippet: "" });
    const garbage = () => new Response("<html>Service Unavailable</html>", { status: 200 });
    const fetchImpl = (async (url: string) => {
      if (url.includes("/messages?")) return json({ messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] });
      if (url.includes("m2")) return garbage();
      return msg(url.includes("m1") ? "First" : "Third");
    }) as unknown as typeof globalThis.fetch;
    const provider = new GmailEmailProvider("token", fetchImpl, noWait);
    const messages = await provider.listRecent(5);
    expect(messages.map((m) => m.subject)).toEqual(["First", "Third"]);
  });

  it("a single message's retry-exhausted 5xx is skipped, the rest survive", async () => {
    const msg = (subject: string) =>
      json({ labelIds: ["INBOX"], payload: { headers: [{ name: "Subject", value: subject }] }, snippet: "" });
    const fetchImpl = (async (url: string) => {
      if (url.includes("/messages?")) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
      if (url.includes("m2")) return status(500);
      return msg("First");
    }) as unknown as typeof globalThis.fetch;
    const provider = new GmailEmailProvider("token", fetchImpl, noWait);
    const messages = await provider.listRecent(5);
    expect(messages.map((m) => m.subject)).toEqual(["First"]);
  });

  it("a 401 mid-batch is propagated (a permanent credential failure is never hidden as a partial list)", async () => {
    const msg = (subject: string) =>
      json({ labelIds: ["INBOX"], payload: { headers: [{ name: "Subject", value: subject }] }, snippet: "" });
    const fetchImpl = (async (url: string) => {
      if (url.includes("/messages?")) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
      if (url.includes("m2")) return status(401);
      return msg("First");
    }) as unknown as typeof globalThis.fetch;
    const provider = new GmailEmailProvider("token", fetchImpl, noWait);
    await expect(provider.listRecent(5)).rejects.toThrow("Gmail auth rejected");
  });
});

describe("GmailEmailProvider — search", () => {
  it("sends the query as Gmail's q= param and returns the matches", async () => {
    let listUrl = "";
    const fetchImpl = (async (url: string) => {
      if (url.includes("/messages?")) {
        listUrl = url;
        return json({ messages: [{ id: "m1" }] });
      }
      return json({ labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "bank@x.com" }, { name: "Subject", value: "Your statement" }] }, snippet: "stmt" });
    }) as unknown as typeof globalThis.fetch;
    const provider = new GmailEmailProvider("token", fetchImpl, noWait);
    const matches = await provider.search("from:bank statement", 5);
    expect(listUrl).toContain("q=from%3Abank%20statement");
    expect(listUrl).not.toContain("labelIds=INBOX");
    expect(matches.map((m) => m.subject)).toEqual(["Your statement"]);
  });

  it("returns [] for a blank query without any HTTP", async () => {
    const fetchImpl = vi.fn(async () => json({})) as unknown as typeof globalThis.fetch;
    const provider = new GmailEmailProvider("token", fetchImpl, noWait);
    expect(await provider.search("   ", 5)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("inherits per-message resilience — one bad match does not drop the rest", async () => {
    const msg = (subject: string) =>
      json({ labelIds: ["INBOX"], payload: { headers: [{ name: "Subject", value: subject }] }, snippet: "" });
    const fetchImpl = (async (url: string) => {
      if (url.includes("/messages?")) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
      if (url.includes("m2")) return new Response("<html>err</html>", { status: 200 });
      return msg("Match");
    }) as unknown as typeof globalThis.fetch;
    const provider = new GmailEmailProvider("token", fetchImpl, noWait);
    const matches = await provider.search("trip", 5);
    expect(matches.map((m) => m.subject)).toEqual(["Match"]);
  });
});

describe("GmailEmailProvider — sendEmail is NEVER retried (no double-send)", () => {
  it("a transient 503 on send throws immediately, fetch called exactly once", async () => {
    const fetchImpl = vi.fn(async () => status(503)) as unknown as typeof globalThis.fetch;
    const provider = new GmailEmailProvider("token", fetchImpl, noWait);
    await expect(provider.sendEmail("a@b.com", "Subj", "Body")).rejects.toThrow("Gmail send failed (503)");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
