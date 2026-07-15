import { describe, expect, it } from "vitest";

import { GoogleCalendarProvider } from "../src/google-provider.js";
import type { CalendarRange } from "../src/types.js";

// Direct coverage for the Google Calendar v3 provider (untested module) — a
// daily-reliability actuator over OAuth. Driven through the injected fetchImpl
// with a contract-faithful HTTP fake that routes the OAuth token endpoint and
// the calendar API separately. Covers the OAuth token lifecycle (mint + cache),
// the reliability contract (retry the idempotent GET; retry a write ONLY on a
// 429 rate-limit honouring Retry-After, never on an ambiguous 5xx), and the
// event ⇄ request-body mapping.

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

interface Call { url: string; method?: string; body?: string; headers: Record<string, string> }

const makeFetch = (
  api: (attempt: number) => Response,
  token: (attempt: number) => Response = () => new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 })
): { impl: typeof fetch; calls: Call[]; apiCalls: () => Call[]; tokenCalls: () => Call[] } => {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ body: init.body as string | undefined, headers: init.headers as Record<string, string>, method: init.method, url: String(url) });
    return String(url) === TOKEN_ENDPOINT ? token(calls.length) : api(calls.length);
  }) as unknown as typeof fetch;
  return { apiCalls: () => calls.filter((c) => c.url !== TOKEN_ENDPOINT), calls, impl, tokenCalls: () => calls.filter((c) => c.url === TOKEN_ENDPOINT) };
};

const provider = (fetchImpl: typeof fetch, retry?: { retries?: number; sleep?: (ms: number) => Promise<void> }) =>
  new GoogleCalendarProvider({ clientId: "c", clientSecret: "s", fetchImpl, refreshToken: "r", ...(retry ? { retry } : {}) });

const RANGE: CalendarRange = { from: new Date("2026-05-30T00:00:00Z"), to: new Date("2026-05-31T00:00:00Z") };
const ITEMS = {
  items: [
    { end: { dateTime: "2026-05-30T09:30:00Z" }, htmlLink: "https://cal/g1", id: "g1", location: "Room A", start: { dateTime: "2026-05-30T09:00:00Z" }, summary: "Standup" },
    { end: { date: "2026-12-26" }, id: "g2", start: { date: "2026-12-25" } }
  ]
};

describe("GoogleCalendarProvider — OAuth + listEvents", () => {
  it("mints an access token, then GETs events with Bearer auth + a time-range query, mapping timed and all-day items", async () => {
    const fetch = makeFetch(() => new Response(JSON.stringify(ITEMS), { status: 200 }));
    const events = await provider(fetch.impl).listEvents(RANGE);

    expect(events).toEqual([
      { allDay: false, endsAt: new Date("2026-05-30T09:30:00Z"), id: "g1", location: "Room A", providerId: "gcal", raw: ITEMS.items[0], startsAt: new Date("2026-05-30T09:00:00Z"), title: "Standup", url: "https://cal/g1" },
      { allDay: true, endsAt: new Date("2026-12-26T00:00:00Z"), id: "g2", providerId: "gcal", raw: ITEMS.items[1], startsAt: new Date("2026-12-25T00:00:00Z"), title: "(untitled)" }
    ]);
    expect(fetch.calls[0]?.url).toBe(TOKEN_ENDPOINT); // token first
    const get = fetch.apiCalls()[0]!;
    expect(get.method).toBe("GET");
    expect(get.headers.authorization).toBe("Bearer tok-1");
    expect(get.url).toMatch(/timeMin=2026-05-30/u);
    expect(get.url).toMatch(/singleEvents=true/u);
  });

  it("CACHES the access token across calls (only one token mint)", async () => {
    const fetch = makeFetch(() => new Response(JSON.stringify(ITEMS), { status: 200 }));
    const p = provider(fetch.impl);
    await p.listEvents(RANGE);
    await p.listEvents(RANGE);
    expect(fetch.tokenCalls()).toHaveLength(1); // reused, not re-minted
  });

  it("throws OAUTH_<status> on a failed refresh and OAUTH_INVALID_RESPONSE when access_token is missing", async () => {
    const failRefresh = makeFetch(() => new Response("{}", { status: 200 }), () => new Response("bad", { status: 401 }));
    await expect(provider(failRefresh.impl).listEvents(RANGE)).rejects.toMatchObject({ code: "OAUTH_401" });

    const noToken = makeFetch(() => new Response("{}", { status: 200 }), () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }));
    await expect(provider(noToken.impl).listEvents(RANGE)).rejects.toMatchObject({ code: "OAUTH_INVALID_RESPONSE" });

    const malformed = makeFetch(() => new Response("{}", { status: 200 }), () => new Response("<html>proxy failure</html>", { status: 200 }));
    await expect(provider(malformed.impl).listEvents(RANGE)).rejects.toMatchObject({ code: "OAUTH_INVALID_RESPONSE", status: 200 });
  });

  it("RETRIES a transient 503 on the idempotent GET, then succeeds", async () => {
    const fetch = makeFetch((attempt) => (attempt < 3 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify(ITEMS), { status: 200 })));
    const events = await provider(fetch.impl, { retries: 2, sleep: async () => {} }).listEvents(RANGE);
    expect(events).toHaveLength(2);
    expect(fetch.apiCalls()).toHaveLength(2); // one retry (token mint shared)
  });

  it("turns a 2xx with a NON-JSON body (HTML maintenance / proxy page) into a typed MALFORMED_RESPONSE, not an opaque SyntaxError", async () => {
    const fetch = makeFetch(() => new Response("<html><body>503 Service Unavailable</body></html>", { status: 200 }));
    await expect(provider(fetch.impl).listEvents(RANGE)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE", status: 200 });
  });

  it("turns an EMPTY 2xx body into MALFORMED_RESPONSE (a 204 no-content is handled separately and does NOT error)", async () => {
    const fetch = makeFetch(() => new Response("", { status: 200 }));
    await expect(provider(fetch.impl).listEvents(RANGE)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE", status: 200 });
  });

  // A fetch that HANGS on the API endpoint (only the AbortController resolves it,
  // by rejecting) — the token endpoint responds normally. Counts how many API
  // attempts the per-request timeout aborted.
  const hangingApiFetch = (counter: { aborts: number }): typeof fetch =>
    (async (url: string, init?: RequestInit) => {
      if (String(url) === TOKEN_ENDPOINT) return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
      const pending = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => {
        counter.aborts += 1;
        pending.reject((init.signal as AbortSignal).reason ?? new Error("aborted"));
      }, { once: true });
      return pending.promise;
    }) as unknown as typeof fetch;

  it("aborts a HUNG GET on the per-attempt timeout (retries, then throws) instead of blocking forever", async () => {
    const counter = { aborts: 0 };
    await expect(provider(hangingApiFetch(counter), { baseDelayMs: 0, retries: 1, sleep: async () => {}, timeoutMs: 20 }).listEvents(RANGE))
      .rejects.toThrow(/timed out/u);
    expect(counter.aborts).toBe(2); // initial + 1 retry, each aborted on its timeout (idempotent GET)
  });

  it("does NOT retry a HUNG WRITE — aborts exactly once and throws (no double-act on an ambiguous timeout)", async () => {
    const counter = { aborts: 0 };
    await expect(
      provider(hangingApiFetch(counter), { baseDelayMs: 0, retries: 2, sleep: async () => {}, timeoutMs: 20 })
        .createEvent({ endsAt: new Date("2026-06-01T11:00:00Z"), startsAt: new Date("2026-06-01T10:00:00Z"), title: "x" })
    ).rejects.toThrow(/timed out/u);
    expect(counter.aborts).toBe(1); // a write network-failure (timeout) is NEVER retried — exactly one attempt
  });
});

describe("GoogleCalendarProvider — writes retry only a 429 rate-limit (never an ambiguous 5xx)", () => {
  it("createEvent POSTs the mapped body and returns the created event", async () => {
    const fetch = makeFetch(() => new Response(JSON.stringify({ end: { dateTime: "2026-06-01T11:00:00Z" }, id: "new1", start: { dateTime: "2026-06-01T10:00:00Z" }, summary: "New" }), { status: 200 }));
    const created = await provider(fetch.impl).createEvent({ endsAt: new Date("2026-06-01T11:00:00Z"), location: "Z", startsAt: new Date("2026-06-01T10:00:00Z"), title: "New" });

    const post = fetch.apiCalls()[0]!;
    expect(post.method).toBe("POST");
    expect(JSON.parse(post.body ?? "{}")).toEqual({ end: { dateTime: "2026-06-01T11:00:00.000Z" }, location: "Z", start: { dateTime: "2026-06-01T10:00:00.000Z" }, summary: "New" });
    expect(created.id).toBe("new1");
  });

  it("does NOT retry a 500 on a write (a retried mutation could double-create)", async () => {
    const fetch = makeFetch(() => new Response("server error", { status: 500 }));
    await expect(provider(fetch.impl, { retries: 2, sleep: async () => {} }).createEvent({ endsAt: new Date(1), startsAt: new Date(0), title: "x" }))
      .rejects.toMatchObject({ code: "HTTP_500" });
    expect(fetch.apiCalls()).toHaveLength(1); // no retry on a write
  });

  it("RETRIES a 429 rate-limit on a write, then succeeds — safe because a 429 is rejected BEFORE the mutation applies", async () => {
    const slept: number[] = [];
    const ok = new Response(JSON.stringify({ end: { dateTime: "2026-06-01T11:00:00Z" }, id: "new1", start: { dateTime: "2026-06-01T10:00:00Z" }, summary: "New" }), { status: 200 });
    const fetch = makeFetch((attempt) => (attempt < 3
      ? new Response("rate limited", { headers: { "retry-after": "2" }, status: 429 })
      : ok));
    const created = await provider(fetch.impl, { retries: 2, sleep: async (ms) => { slept.push(ms); } })
      .createEvent({ endsAt: new Date("2026-06-01T11:00:00Z"), startsAt: new Date("2026-06-01T10:00:00Z"), title: "New" });

    expect(created.id).toBe("new1");
    expect(fetch.apiCalls()).toHaveLength(2); // one 429 + one success
    expect(slept).toEqual([2000]); // honoured Retry-After (2s), NOT the 250ms backoff
  });

  it("a write 429 with no Retry-After falls back to exponential backoff", async () => {
    const slept: number[] = [];
    const ok = new Response(JSON.stringify({ end: { dateTime: "2026-06-01T11:00:00Z" }, id: "n", start: { dateTime: "2026-06-01T10:00:00Z" }, summary: "N" }), { status: 200 });
    const fetch = makeFetch((attempt) => (attempt < 3 ? new Response("rate", { status: 429 }) : ok));
    await provider(fetch.impl, { retries: 2, sleep: async (ms) => { slept.push(ms); } })
      .createEvent({ endsAt: new Date(1), startsAt: new Date(0), title: "x" });

    expect(slept).toEqual([250]); // baseDelayMs * 2^0, no server hint
  });

  it("exhausts the 429 retry budget on a write and surfaces HTTP_429 (no infinite loop)", async () => {
    const fetch = makeFetch(() => new Response("rate", { headers: { "retry-after": "1" }, status: 429 }));
    await expect(provider(fetch.impl, { retries: 2, sleep: async () => {} }).createEvent({ endsAt: new Date(1), startsAt: new Date(0), title: "x" }))
      .rejects.toMatchObject({ code: "HTTP_429" });
    expect(fetch.apiCalls()).toHaveLength(3); // initial + 2 retries, then give up
  });

  it("deleteEvent issues a DELETE and treats 204 as success (void)", async () => {
    const fetch = makeFetch(() => new Response(null, { status: 204 }));
    await expect(provider(fetch.impl).deleteEvent("g1")).resolves.toBeUndefined();
    expect(fetch.apiCalls()[0]?.method).toBe("DELETE");
  });
});
