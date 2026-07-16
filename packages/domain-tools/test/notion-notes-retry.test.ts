import { describe, expect, it } from "vitest";

import { NotionNotesProvider } from "../src/index.js";

const noWait = { baseDelayMs: 0, sleep: async () => {} };

const QUERY_OK = JSON.stringify({
  results: [
    {
      id: "page-1",
      last_edited_time: "2026-05-09T10:00:00Z",
      parent: { database_id: "db_xyz" },
      properties: { Name: { title: [{ plain_text: "Daily standup" }] } }
    }
  ]
});

function sequence(responses: Array<{ status: number; body: string }>, onCall?: () => void) {
  let i = 0;
  const fetchImpl = (async () => {
    onCall?.();
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(r.body, { status: r.status });
  }) as unknown as (input: string, init: RequestInit) => Promise<Response>;
  return fetchImpl;
}

describe("NotionNotesProvider — read retries a transient 429 (Notion rate-limit)", () => {
  it("rejects a non-Notion endpoint before a token can be sent", () => {
    expect(() => new NotionNotesProvider({ endpoint: "https://example.test/v1", fetchImpl: sequence([]), token: "t" })).toThrow();
  });

  it("list() recovers from a 429 then succeeds (the real-world rate-limit failure mode)", async () => {
    let calls = 0;
    const notion = new NotionNotesProvider({
      databaseId: "db_xyz",
      fetchImpl: sequence([{ body: "rate limited", status: 429 }, { body: QUERY_OK, status: 200 }], () => { calls += 1; }),
      retry: noWait,
      token: "t"
    });
    const entries = await notion.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "page-1", title: "Daily standup" });
    expect(calls).toBe(2); // retried once after the 429
  });

  it("a permanent 401 (bad token) fails fast — no retry", async () => {
    let calls = 0;
    const notion = new NotionNotesProvider({
      databaseId: "db_xyz",
      fetchImpl: sequence([{ body: "unauthorized", status: 401 }], () => { calls += 1; }),
      retry: noWait,
      token: "t"
    });
    await expect(notion.list()).rejects.toMatchObject({ code: "NOTION_AUTH" });
    expect(calls).toBe(1);
  });

  it("a WRITE (save create) is NOT retried on 429 — a retried create could duplicate the page", async () => {
    let calls = 0;
    const notion = new NotionNotesProvider({
      databaseId: "db_xyz",
      fetchImpl: sequence([{ body: "rate limited", status: 429 }], () => { calls += 1; }),
      retry: noWait,
      token: "t"
    });
    await expect(notion.save({ body: "b", title: "New note" })).rejects.toMatchObject({ code: "NOTION_RATE_LIMIT" });
    expect(calls).toBe(1);
  });
});
