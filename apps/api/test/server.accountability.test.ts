import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendActionLog } from "@muse/stores";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

// Route-integration (backlog P2): boot the real Fastify app and exercise the
// accountability route group end-to-end — the outbound-safety audit surface
// (read-only action log / objectives / vetoes + local contacts CRUD). Auth is
// disabled (no authService) so the routes are open, matching the personal-use
// default.
describe("api server: /api/actions, /api/contacts, /api/objectives, /api/vetoes", () => {
  const servers: { close: () => Promise<unknown> }[] = [];
  function makeServer() {
    const dir = mkdtempSync(join(tmpdir(), "muse-api-accountability-"));
    const files = {
      actionLogFile: join(dir, "actions.json"),
      contactsFile: join(dir, "contacts.json"),
      objectivesFile: join(dir, "objectives.json"),
      vetoesFile: join(dir, "vetoes.json"),
    };
    const server = buildServer({ logger: false, ...files });
    servers.push(server);
    return { files, server };
  }
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it("returns empty read-only collections before anything is recorded", async () => {
    const { server } = makeServer();
    for (const [url, key] of [["/api/actions", "actions"], ["/api/objectives", "objectives"], ["/api/vetoes", "vetoes"], ["/api/contacts", "contacts"]] as const) {
      const res = await server.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ [key]: [], total: 0 });
    }
  });

  it("CRUDs a local contact: POST persists, GET reflects, DELETE removes", async () => {
    const { server } = makeServer();
    const created = await server.inject({ method: "POST", payload: { email: "mom@example.com", name: "Mom" }, url: "/api/contacts" });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ email: "mom@example.com", name: "Mom" });
    const id = (created.json() as { id: string }).id;

    const listed = await server.inject({ method: "GET", url: "/api/contacts" });
    expect(listed.json()).toMatchObject({ total: 1 });
    expect((listed.json() as { contacts: { id: string }[] }).contacts[0]!.id).toBe(id);

    const removed = await server.inject({ method: "DELETE", url: `/api/contacts/${id}` });
    expect(removed.json()).toEqual({ id, removed: true });
    expect((await server.inject({ method: "GET", url: "/api/contacts" })).json()).toMatchObject({ total: 0 });
  });

  it("rejects a contact with no name (400), and a delete of an unknown id reports removed:false", async () => {
    const { server } = makeServer();
    const bad = await server.inject({ method: "POST", payload: {}, url: "/api/contacts" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "name is required" });

    const del = await server.inject({ method: "DELETE", url: "/api/contacts/does-not-exist" });
    expect(del.json()).toEqual({ id: "does-not-exist", removed: false });
  });

  it("serves the recorded action log (newest-first) at /api/actions", async () => {
    const { files, server } = makeServer();
    await appendActionLog(files.actionLogFile, { id: "a1", result: "performed", userId: "u", what: "older", when: "2026-01-01T00:00:00Z", why: "r" });
    await appendActionLog(files.actionLogFile, { id: "a2", result: "refused", userId: "u", what: "newer", when: "2026-02-01T00:00:00Z", why: "r" });

    const res = await server.inject({ method: "GET", url: "/api/actions" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { actions: { id: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.actions.map((a) => a.id)).toEqual(["a2", "a1"]); // newest-first
  });
});
