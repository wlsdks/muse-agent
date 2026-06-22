import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("api server: GET /api/multi-agent/runs — live sub-agent run registry surface", () => {
  it("exposes the live-runs route with the registry shape (wired into the real server)", async () => {
    const server = buildServer({ logger: false });
    const reply = await server.inject({ method: "GET", url: "/api/multi-agent/runs" });
    expect(reply.statusCode).toBe(200);
    const body = reply.json() as { activeCount: number; runs: unknown[]; timedOutOnRead: number };
    expect(body).toMatchObject({ activeCount: 0, runs: [], timedOutOnRead: 0 });
  });
});
