import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppleRemindersProvider, LocalFileTasksProvider, TasksProviderRegistry } from "@muse/domain-tools";
import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("api server: /api/tasks/providers", () => {
  it("reports the inline filesystem-only baseline when no registry is wired", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-api-tasks-providers-"));
    const tasksFile = join(root, "tasks.json");
    const server = buildServer({ logger: false, tasksFile });

    const reply = await server.inject({ method: "GET", url: "/api/tasks/providers" });
    expect(reply.statusCode).toBe(200);
    const body = reply.json() as { providers: { id: string; local: boolean; description: string }[] };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({
      id: "local",
      local: true
    });
    expect(body.providers[0]?.description).toContain(tasksFile);
  });

  it("reports the wired registry when present", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-api-tasks-providers-registry-"));
    const tasksFile = join(root, "tasks.json");
    const registry = new TasksProviderRegistry();
    registry.register(new LocalFileTasksProvider({ file: tasksFile }));
    registry.register(new AppleRemindersProvider({ list: "Personal" }));
    const server = buildServer({
      logger: false,
      tasksFile,
      tasksProviderRegistry: registry
    });

    const reply = await server.inject({ method: "GET", url: "/api/tasks/providers" });
    expect(reply.statusCode).toBe(200);
    const body = reply.json() as { providers: { id: string; local: boolean }[] };
    expect(body.providers).toHaveLength(2);
    const ids = body.providers.map((info) => info.id);
    expect(ids).toEqual(expect.arrayContaining(["local", "apple-reminders"]));
    const apple = body.providers.find((info) => info.id === "apple-reminders");
    expect(apple?.local).toBe(true);
  });

  it("404s when no tasksFile is configured (route block not registered)", async () => {
    const server = buildServer({ logger: false });
    const reply = await server.inject({ method: "GET", url: "/api/tasks/providers" });
    expect(reply.statusCode).toBe(404);
  });
});

describe("api server: /api/tasks invalid dueAt uses a consistent error code", () => {
  it("POST and PATCH both return code INVALID_TASK_DUE_AT for an unparseable dueAt", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-api-tasks-dueat-"));
    const server = buildServer({ logger: false, tasksFile: join(root, "tasks.json") });

    const postBad = await server.inject({
      method: "POST",
      payload: { dueAt: "definitely-not-a-date", title: "x" },
      url: "/api/tasks"
    });
    expect(postBad.statusCode).toBe(400);
    expect((postBad.json() as { code: string }).code).toBe("INVALID_TASK_DUE_AT");

    const created = await server.inject({
      method: "POST",
      payload: { title: "edit me" },
      url: "/api/tasks"
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const patchBad = await server.inject({
      method: "PATCH",
      payload: { dueAt: "still-not-a-date" },
      url: `/api/tasks/${id}`
    });
    expect(patchBad.statusCode).toBe(400);
    // Same machine-readable code as POST (was the ad-hoc BAD_DUE_AT,
    // diverging from the INVALID_<RESOURCE>_DUE_AT convention).
    expect((patchBad.json() as { code: string }).code).toBe("INVALID_TASK_DUE_AT");
  });
});
