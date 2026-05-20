import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("api server: GET /api/multi-agent/orchestrations — strict-parse on ?limit", () => {
  it("400s on `?limit=20x` instead of silently truncating via lenient parseInt", async () => {
    const server = buildServer({ logger: false });
    const reply = await server.inject({ method: "GET", url: "/api/multi-agent/orchestrations?limit=20x" });
    expect(reply.statusCode, "lenient `Number.parseInt(\"20x\", 10) === 20` previously masqueraded as a valid 20-row request — strict parse must surface the typo").toBe(400);
    expect(reply.json()).toMatchObject({ code: "INVALID_LIMIT" });
  });

  it("400s on unit-slip `?limit=5min` and on bare-junk `?limit=abc`", async () => {
    const server = buildServer({ logger: false });
    const unit = await server.inject({ method: "GET", url: "/api/multi-agent/orchestrations?limit=5min" });
    expect(unit.statusCode).toBe(400);
    expect(unit.json()).toMatchObject({ code: "INVALID_LIMIT" });
    const junk = await server.inject({ method: "GET", url: "/api/multi-agent/orchestrations?limit=abc" });
    expect(junk.statusCode).toBe(400);
  });

  it("accepts a valid decimal `?limit=10` and a missing limit (no clamp)", async () => {
    const server = buildServer({ logger: false });
    const valid = await server.inject({ method: "GET", url: "/api/multi-agent/orchestrations?limit=10" });
    expect(valid.statusCode).toBe(200);
    const noLimit = await server.inject({ method: "GET", url: "/api/multi-agent/orchestrations" });
    expect(noLimit.statusCode).toBe(200);
  });

  it("still 400s on out-of-range valid integers (preserves the pre-fix range contract)", async () => {
    const server = buildServer({ logger: false });
    const tooBig = await server.inject({ method: "GET", url: "/api/multi-agent/orchestrations?limit=10000" });
    expect(tooBig.statusCode).toBe(400);
    const negative = await server.inject({ method: "GET", url: "/api/multi-agent/orchestrations?limit=-5" });
    expect(negative.statusCode).toBe(400);
  });
});
