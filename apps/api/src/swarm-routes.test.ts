import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addToQuarantine } from "@muse/stores";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerSwarmRoutes } from "./swarm-routes.js";

// The swarm's "inbound is inert" guarantee, web half: pending lists the
// quarantine, promote works ONLY for skills and produces an authored
// skill, reject resolves without side effects, and a resolved entry
// leaves the queue.

const dir = mkdtempSync(join(tmpdir(), "muse-swarm-routes-"));
afterEach(() => rmSync(dir, { force: true, recursive: true }));

const seed = async (file: string, kind: "skill" | "strategy", id: string) =>
  addToQuarantine(file, { content: "# know-how", fromPeerId: "peer-a", id, kind, receivedAtMs: 1_752_000_000_000 });

function build(file: string, skillsDir: string) {
  const server = Fastify();
  registerSwarmRoutes(server, { authService: undefined, authoredSkillsDir: skillsDir, quarantineFile: file });
  return server;
}

describe("swarm quarantine routes", () => {
  it("pending lists only unresolved entries; promote turns a skill into an authored skill and clears it", async () => {
    const file = join(dir, "q1.json");
    const skillsDir = join(dir, "skills1");
    await seed(file, "skill", "sk-11111111");
    const server = build(file, skillsDir);

    const pending = await server.inject({ method: "GET", url: "/api/swarm/pending" });
    expect(JSON.parse(pending.body)).toMatchObject({ total: 1 });

    const promote = await server.inject({ method: "POST", url: "/api/swarm/sk-1111/promote" });
    expect(promote.statusCode).toBe(200);
    expect(JSON.parse(promote.body)).toMatchObject({ promoted: true });

    const after = await server.inject({ method: "GET", url: "/api/swarm/pending" });
    expect(JSON.parse(after.body)).toMatchObject({ total: 0 });
    await server.close();
  });

  it("non-skill kinds refuse promotion (409); unknown ids 404; reject resolves", async () => {
    const file = join(dir, "q2.json");
    await seed(file, "strategy", "st-22222222");
    const server = build(file, join(dir, "skills2"));

    expect((await server.inject({ method: "POST", url: "/api/swarm/st-2222/promote" })).statusCode).toBe(409);
    expect((await server.inject({ method: "POST", url: "/api/swarm/ghost/promote" })).statusCode).toBe(404);

    const reject = await server.inject({ method: "POST", url: "/api/swarm/st-2222/reject" });
    expect(reject.statusCode).toBe(200);
    expect(JSON.parse((await server.inject({ method: "GET", url: "/api/swarm/pending" })).body)).toMatchObject({ total: 0 });
    await server.close();
  });
});
