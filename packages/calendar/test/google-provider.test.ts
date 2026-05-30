import { describe, expect, it } from "vitest";

import { GoogleCalendarProvider } from "../src/google-provider.js";
import type { CalendarRange } from "../src/types.js";

// Direct coverage for the Google Calendar v3 provider (untested module) — a
// daily-reliability actuator over OAuth. Driven through the injected fetchImpl
// with a contract-faithful HTTP fake that routes the OAuth token endpoint and
// the calendar API separately. Covers the OAuth token lifecycle (mint + cache),
// the reliability contract (retry the idempotent GET, NEVER retry a write), and
// the event ⇄ request-body mapping.

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
  });

  it("RETRIES a transient 503 on the idempotent GET, then succeeds", async () => {
    const fetch = makeFetch((attempt) => (attempt < 3 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify(ITEMS), { status: 200 })));
    const events = await provider(fetch.impl, { retries: 2, sleep: async () => {} }).listEvents(RANGE);
    expect(events).toHaveLength(2);
    expect(fetch.apiCalls()).toHaveLength(2); // one retry (token mint shared)
  });
});

describe("GoogleCalendarProvider — writes are never retried", () => {
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

  it("deleteEvent issues a DELETE and treats 204 as success (void)", async () => {
    const fetch = makeFetch(() => new Response(null, { status: 204 }));
    await expect(provider(fetch.impl).deleteEvent("g1")).resolves.toBeUndefined();
    expect(fetch.apiCalls()[0]?.method).toBe("DELETE");
  });
});
