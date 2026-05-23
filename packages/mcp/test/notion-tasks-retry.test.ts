import { describe, expect, it } from "vitest";

import { NotionTasksProvider } from "../src/index.js";

const noWait = { baseDelayMs: 0, sleep: async () => {} };

const QUERY_OK = JSON.stringify({
  results: [
    {
      id: "task-1",
      properties: {
        Name: { title: [{ plain_text: "Ship the brief" }] },
        Status: { status: { name: "Open" } }
      }
    }
  ]
});

function sequence(responses: Array<{ status: number; body: string }>, onCall?: () => void) {
  let i = 0;
  return (async () => {
    onCall?.();
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(r.body, { status: r.status });
  }) as unknown as (input: string, init: RequestInit) => Promise<Response>;
}

describe("NotionTasksProvider — read retries a transient 429 (Notion rate-limit)", () => {
  it("list() recovers from a 429 then succeeds", async () => {
    let calls = 0;
    const tasks = new NotionTasksProvider({
      databaseId: "db1",
      fetchImpl: sequence([{ body: "rate limited", status: 429 }, { body: QUERY_OK, status: 200 }], () => { calls += 1; }),
      retry: noWait,
      token: "t"
    });
    const list = await tasks.list("all");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "task-1", title: "Ship the brief" });
    expect(calls).toBe(2);
  });

  it("a permanent 401 fails fast — no retry", async () => {
    let calls = 0;
    const tasks = new NotionTasksProvider({
      databaseId: "db1",
      fetchImpl: sequence([{ body: "unauthorized", status: 401 }], () => { calls += 1; }),
      retry: noWait,
      token: "t"
    });
    await expect(tasks.list("all")).rejects.toMatchObject({ code: "NOTION_AUTH" });
    expect(calls).toBe(1);
  });

  it("a WRITE (add) is NOT retried on 429 — a retried create could duplicate the task", async () => {
    let calls = 0;
    const tasks = new NotionTasksProvider({
      databaseId: "db1",
      fetchImpl: sequence([{ body: "rate limited", status: 429 }], () => { calls += 1; }),
      retry: noWait,
      token: "t"
    });
    await expect(tasks.add({ title: "New task" })).rejects.toMatchObject({ code: "NOTION_RATE_LIMIT" });
    expect(calls).toBe(1);
  });
});
