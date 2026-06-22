import { describe, expect, it } from "vitest";

import { NotionNotesProvider } from "../src/index.js";

const noWait = { baseDelayMs: 0, sleep: async () => {} };

// Notion API fixtures (minimal shapes the provider actually reads).
const page = (id: string, title: string) => ({
  id,
  last_edited_time: "2026-05-25T10:00:00Z",
  parent: { database_id: "db_xyz" },
  properties: { Name: { title: [{ plain_text: title }] } }
});
const blocks = (...lines: string[]) => ({
  results: lines.map((text) => ({ id: `b-${text}`, paragraph: { rich_text: [{ plain_text: text }] }, type: "paragraph" }))
});

// Drive a scripted sequence of JSON responses; record the (method, path) of each call.
function scripted(responses: Array<{ status: number; body: unknown }>): { fetchImpl: (input: string, init: RequestInit) => Promise<Response>; calls: Array<{ method: string; url: string }> } {
  const calls: Array<{ method: string; url: string }> = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ method: (init?.method ?? "GET").toString(), url });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as (input: string, init: RequestInit) => Promise<Response>;
  return { calls, fetchImpl };
}

function provider(responses: Array<{ status: number; body: unknown }>): { notion: NotionNotesProvider; calls: Array<{ method: string; url: string }> } {
  const { fetchImpl, calls } = scripted(responses);
  return { calls, notion: new NotionNotesProvider({ databaseId: "db_xyz", fetchImpl, retry: noWait, token: "t" }) };
}

describe("NotionNotesProvider — happy paths (real API call shapes, HTTP faked)", () => {
  it("save(create) POSTs a page then reads it back with its body", async () => {
    const { notion, calls } = provider([
      { body: { id: "new-1" }, status: 200 },              // POST /pages
      { body: page("new-1", "Meeting notes"), status: 200 }, // GET /pages/new-1
      { body: blocks("line one", "line two"), status: 200 }  // GET blocks
    ]);
    const saved = await notion.save({ body: "line one\nline two", title: "Meeting notes" });
    expect(saved).toMatchObject({ id: "new-1", title: "Meeting notes", body: "line one\nline two" });
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]!.url).toContain("/pages");
  });

  it("list() maps database query rows to note entries", async () => {
    const { notion } = provider([{ body: { results: [page("page-1", "Daily standup")] }, status: 200 }]);
    const entries = await notion.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "page-1", title: "Daily standup" });
  });

  it("read() joins child paragraph blocks into the note body", async () => {
    const { notion } = provider([
      { body: page("page-1", "Daily standup"), status: 200 },
      { body: blocks("first", "second"), status: 200 }
    ]);
    const content = await notion.read("page-1");
    expect(content).toMatchObject({ id: "page-1", title: "Daily standup", body: "first\nsecond" });
  });
});
