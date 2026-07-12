import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerBoardRoutes } from "./board-routes.js";

describe("GET /api/board — the web Kanban feed", () => {
  it("returns the board tasks from the injected source", async () => {
    const server = Fastify();
    registerBoardRoutes(server, {
      listTasks: async () => [
        { createdAt: "t", dependsOn: [], id: "a", runs: [], status: "todo", title: "x", updatedAt: "t" },
        { createdAt: "t", decomposed: true, dependsOn: ["a"], id: "c", runs: [], status: "todo", synthesize: true, title: "container", updatedAt: "t" }
      ]
    });
    const res = await server.inject({ method: "GET", url: "/api/board" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { tasks: { id: string; synthesize?: boolean }[] };
    expect(body.tasks.map((t) => t.id)).toEqual(["a", "c"]);
    expect(body.tasks[1]!.synthesize).toBe(true);
    await server.close();
  });
  it("an empty board returns an empty tasks array (never errors)", async () => {
    const server = Fastify();
    registerBoardRoutes(server, { listTasks: async () => [] });
    const res = await server.inject({ method: "GET", url: "/api/board" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ tasks: [] });
    await server.close();
  });
});

describe("board write routes — the web management verbs", () => {
  const memoryBoard = (seed: readonly import("@muse/multi-agent").AgentTask[] = []) => {
    let tasks = [...seed];
    return {
      list: async () => tasks,
      mutate: async (transform: (t: readonly import("@muse/multi-agent").AgentTask[]) => import("@muse/multi-agent").AgentTask[]) => {
        tasks = transform(tasks);
        return tasks;
      }
    };
  };
  const seedTask = (id: string, status: import("@muse/multi-agent").TaskStatus = "todo") =>
    ({ createdAt: "t", dependsOn: [], id, runs: [], status, title: id, updatedAt: "t" });

  it("POST adds a task; blank title is rejected", async () => {
    const server = Fastify();
    const board = memoryBoard();
    registerBoardRoutes(server, { board });
    const bad = await server.inject({ method: "POST", url: "/api/board/tasks", payload: { title: "  " } });
    expect(bad.statusCode).toBe(400);
    const res = await server.inject({ method: "POST", url: "/api/board/tasks", payload: { title: "write docs" } });
    expect(res.statusCode).toBe(201);
    expect((JSON.parse(res.body) as { task: { title: string; status: string } }).task).toMatchObject({ status: "todo", title: "write docs" });
    expect((await board.list())).toHaveLength(1);
    await server.close();
  });

  it("PATCH moves a task; invalid status and unknown id are rejected", async () => {
    const server = Fastify();
    const board = memoryBoard([seedTask("a")]);
    registerBoardRoutes(server, { board });
    expect((await server.inject({ method: "PATCH", url: "/api/board/tasks/a", payload: { status: "flying" } })).statusCode).toBe(400);
    expect((await server.inject({ method: "PATCH", url: "/api/board/tasks/zz", payload: { status: "done" } })).statusCode).toBe(404);
    const ok = await server.inject({ method: "PATCH", url: "/api/board/tasks/a", payload: { status: "in_progress" } });
    expect(ok.statusCode).toBe(200);
    expect((await board.list())[0]!.status).toBe("in_progress");
    await server.close();
  });

  it("retry re-queues only blocked/failed; review resolves only review tasks; delete removes", async () => {
    const server = Fastify();
    const board = memoryBoard([seedTask("todo1"), seedTask("stuck", "blocked"), seedTask("rev", "review")]);
    registerBoardRoutes(server, { board });
    expect((await server.inject({ method: "POST", url: "/api/board/tasks/todo1/retry" })).statusCode).toBe(409);
    expect((await server.inject({ method: "POST", url: "/api/board/tasks/stuck/retry" })).statusCode).toBe(200);
    expect((await board.list()).find((t) => t.id === "stuck")!.status).toBe("todo");

    expect((await server.inject({ method: "POST", url: "/api/board/tasks/todo1/review", payload: { approved: true } })).statusCode).toBe(409);
    expect((await server.inject({ method: "POST", url: "/api/board/tasks/rev/review", payload: { approved: false } })).statusCode).toBe(200);
    expect((await board.list()).find((t) => t.id === "rev")!.status).toBe("blocked");

    expect((await server.inject({ method: "DELETE", url: "/api/board/tasks/todo1" })).statusCode).toBe(204);
    expect((await board.list()).some((t) => t.id === "todo1")).toBe(false);
    await server.close();
  });
});
