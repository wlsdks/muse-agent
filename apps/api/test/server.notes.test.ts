import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalDirNotesProvider, NotesProviderRegistry, NotionNotesProvider } from "@muse/domain-tools";
import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("api server: /api/notes/*", () => {
  function makeServer() {
    const notesDir = mkdtempSync(join(tmpdir(), "muse-api-notes-"));
    const server = buildServer({ logger: false, notesDir });
    return { notesDir, server };
  }

  it("save → read → list → search → append round-trips against /api/notes/*", async () => {
    const { server } = makeServer();

    const save = await server.inject({
      method: "POST",
      payload: { content: "alpha\nbeta keyword\n", path: "diary.md" },
      url: "/api/notes/save"
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({ path: "diary.md", created: true });

    const read = await server.inject({
      method: "GET",
      url: "/api/notes/read?path=diary.md"
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ path: "diary.md", content: "alpha\nbeta keyword\n" });

    const list = await server.inject({ method: "GET", url: "/api/notes/list" });
    expect(list.statusCode).toBe(200);
    const listed = list.json() as { entries: { name: string }[] };
    expect(listed.entries.some((entry) => entry.name === "diary.md")).toBe(true);

    const search = await server.inject({
      method: "GET",
      url: "/api/notes/search?query=keyword"
    });
    expect(search.statusCode).toBe(200);
    const hits = search.json() as { matches: { path: string; line: number }[] };
    expect(hits.matches[0]).toMatchObject({ path: "diary.md", line: 2 });

    const append = await server.inject({
      method: "POST",
      payload: { content: "gamma\n", path: "diary.md" },
      url: "/api/notes/append"
    });
    expect(append.statusCode).toBe(200);

    const reread = await server.inject({
      method: "GET",
      url: "/api/notes/read?path=diary.md"
    });
    expect((reread.json() as { content: string }).content).toContain("gamma");
  });

  it("rejects unsafe paths with 400 error body", async () => {
    const { server } = makeServer();

    const escape = await server.inject({
      method: "GET",
      url: "/api/notes/read?path=..%2Fetc%2Fpasswd"
    });
    expect(escape.statusCode).toBe(400);
    expect(escape.json()).toMatchObject({ error: expect.stringContaining("escape") });

    const missing = await server.inject({ method: "GET", url: "/api/notes/read" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "path is required" });
  });

  it("save without overwrite returns an error body when the note already exists", async () => {
    const { server } = makeServer();

    const first = await server.inject({
      method: "POST",
      payload: { content: "v1", path: "doc.md" },
      url: "/api/notes/save"
    });
    expect(first.statusCode).toBe(200);

    const conflict = await server.inject({
      method: "POST",
      payload: { content: "v2", path: "doc.md" },
      url: "/api/notes/save"
    });
    expect(conflict.statusCode).toBe(400);
    expect(conflict.json()).toMatchObject({ error: expect.stringContaining("already exists") });

    const overwrite = await server.inject({
      method: "POST",
      payload: { content: "v2", overwrite: true, path: "doc.md" },
      url: "/api/notes/save"
    });
    expect(overwrite.statusCode).toBe(200);
  });

  it("notes routes are absent when no notesDir is configured", async () => {
    const server = buildServer({ logger: false });
    const reply = await server.inject({ method: "GET", url: "/api/notes/list" });
    expect(reply.statusCode).toBe(404);
  });

  it("GET /api/notes/providers reports the inline filesystem-only baseline when no registry is wired", async () => {
    const { server, notesDir } = makeServer();

    const reply = await server.inject({ method: "GET", url: "/api/notes/providers" });
    expect(reply.statusCode).toBe(200);
    const body = reply.json() as { providers: { id: string; local: boolean; description: string }[] };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({
      id: "local",
      local: true
    });
    expect(body.providers[0]?.description).toContain(notesDir);
  });

  it("GET /api/notes/providers reports the wired registry when present", async () => {
    const notesDir = mkdtempSync(join(tmpdir(), "muse-api-notes-providers-"));
    const registry = new NotesProviderRegistry();
    registry.register(new LocalDirNotesProvider({ notesDir }));
    registry.register(new NotionNotesProvider({
      databaseId: "11111111-1111-1111-1111-111111111111",
      fetchImpl: async () => new Response("{}", { status: 200 }),
      token: "secret-test-token"
    }));
    const server = buildServer({ logger: false, notesDir, notesProviderRegistry: registry });

    const reply = await server.inject({ method: "GET", url: "/api/notes/providers" });
    expect(reply.statusCode).toBe(200);
    const body = reply.json() as { providers: { id: string; local: boolean }[] };
    expect(body.providers).toHaveLength(2);
    const ids = body.providers.map((info) => info.id);
    expect(ids).toEqual(expect.arrayContaining(["local", "notion"]));
    const notionInfo = body.providers.find((info) => info.id === "notion");
    expect(notionInfo?.local).toBe(false);
  });
});
