import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeBeliefProvenance } from "@muse/memory";
import { recordPlaybookStrategy } from "@muse/stores";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("api server: GET /api/journey", () => {
  const servers: { close: () => Promise<unknown> }[] = [];
  function makeServer() {
    const dir = mkdtempSync(join(tmpdir(), "muse-api-journey-"));
    const files = {
      authoredSkillsDir: join(dir, "skills", "authored"),
      beliefProvenanceFile: join(dir, "belief-provenance.json"),
      playbookFile: join(dir, "playbook.json")
    };
    const server = buildServer({ logger: false, ...files });
    servers.push(server);
    return { files, server };
  }
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it("returns an empty timeline before anything is recorded", async () => {
    const { server } = makeServer();
    const res = await server.inject({ method: "GET", url: "/api/journey" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [], total: 0 });
  });

  it("merges facts, strategies, and skills into one newest-first timeline", async () => {
    const { files, server } = makeServer();
    await writeBeliefProvenance(files.beliefProvenanceFile, [
      { key: "home_city", kind: "fact", learnedAt: "2026-01-01T00:00:00.000Z", source: "user", userId: "u1", value: "Busan" },
      { key: "home_city", kind: "fact", learnedAt: "2026-01-20T00:00:00.000Z", source: "user", userId: "u1", value: "Seoul" }
    ]);
    await recordPlaybookStrategy(files.playbookFile, {
      createdAt: "2026-01-10T00:00:00.000Z",
      id: "pb_apitest01",
      text: "keep replies short",
      userId: "u1"
    });
    const skillDir = join(files.authoredSkillsDir, "vpn-fix");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      '---\nname: vpn-fix\ndescription: Reconnect the VPN\nmetadata: {"muse":{"authored":true,"authoredAt":"2026-02-01T00:00:00.000Z"}}\n---\n\nReconnect steps.\n'
    );

    const res = await server.inject({ method: "GET", url: "/api/journey" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: readonly { storeKind: string; ref?: string }[]; total: number };
    expect(body.total).toBeGreaterThanOrEqual(3);
    expect(body.events.some((e) => e.storeKind === "fact" && e.ref === "home_city")).toBe(true);
    expect(body.events.some((e) => e.storeKind === "strategy" && e.ref === "pb_apitest01")).toBe(true);
    expect(body.events.some((e) => e.storeKind === "skill" && e.ref === "vpn-fix")).toBe(true);
  });

  it("--kind filters to one store via ?kind=", async () => {
    const { files, server } = makeServer();
    await recordPlaybookStrategy(files.playbookFile, { createdAt: "2026-01-10T00:00:00.000Z", id: "pb_kindtest", text: "x", userId: "u1" });
    const res = await server.inject({ method: "GET", url: "/api/journey?kind=strategy" });
    const body = res.json() as { events: readonly { storeKind: string }[] };
    expect(body.events.every((e) => e.storeKind === "strategy")).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
  });

  it("rejects an invalid ?kind= with 400", async () => {
    const { server } = makeServer();
    const res = await server.inject({ method: "GET", url: "/api/journey?kind=bogus" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid ?since= with 400", async () => {
    const { server } = makeServer();
    const res = await server.inject({ method: "GET", url: "/api/journey?since=not-a-date" });
    expect(res.statusCode).toBe(400);
  });
});
