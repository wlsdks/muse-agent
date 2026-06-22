import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendProactiveHistory, type ProactiveHistoryEntry } from "@muse/stores";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

// Route-integration (backlog P2): the proactive surfacing audit API. The route
// is registered ONLY when a proactiveHistoryFile is wired; it serves the
// daemon's per-firing log newest-first with a clamped limit.
describe("api server: GET /api/proactive/history", () => {
  const servers: { close: () => Promise<unknown> }[] = [];
  const track = <T extends { close: () => Promise<unknown> }>(s: T): T => { servers.push(s); return s; };
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

  const entry = (i: number): ProactiveHistoryEntry => ({
    destination: "C1",
    firedAtIso: `2026-01-0${i}T00:00:00Z`,
    itemId: `i${i}`,
    kind: "calendar",
    providerId: "slack",
    startIso: `2026-01-0${i}T00:00:00Z`,
    status: "delivered",
    text: "your 3pm meeting starts soon",
    title: `event ${i}`,
  });

  function makeServer() {
    const file = join(mkdtempSync(join(tmpdir(), "muse-api-proactive-")), "history.json");
    return { file, server: track(buildServer({ logger: false, proactiveHistoryFile: file })) };
  }

  it("serves the recorded history newest-first with a total", async () => {
    const { file, server } = makeServer();
    for (let i = 1; i <= 3; i += 1) await appendProactiveHistory(file, entry(i));
    const res = await server.inject({ method: "GET", url: "/api/proactive/history" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: { itemId: string }[]; total: number };
    expect(body.total).toBe(3);
    expect(body.entries.map((e) => e.itemId)).toEqual(["i3", "i2", "i1"]);
  });

  it("honours the ?limit query (still newest-first)", async () => {
    const { file, server } = makeServer();
    for (let i = 1; i <= 3; i += 1) await appendProactiveHistory(file, entry(i));
    const res = await server.inject({ method: "GET", url: "/api/proactive/history?limit=1" });
    expect((res.json() as { entries: { itemId: string }[] }).entries.map((e) => e.itemId)).toEqual(["i3"]);
  });

  it("returns an empty audit for a fresh (unwritten) history file", async () => {
    const { server } = makeServer();
    expect((await server.inject({ method: "GET", url: "/api/proactive/history" })).json()).toEqual({ entries: [], total: 0 });
  });

  it("does not register the route when no proactiveHistoryFile is configured (404)", async () => {
    const server = track(buildServer({ logger: false }));
    expect((await server.inject({ method: "GET", url: "/api/proactive/history" })).statusCode).toBe(404);
  });
});
