import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FileAgentTaskBoard, readBoard, writeBoard } from "../src/board-store.js";
import { addTask } from "../src/task-board.js";

let dir = "";
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "muse-board-")); });
afterAll(async () => { await rm(dir, { force: true, recursive: true }); });
const freshFile = () => join(dir, `board-${randomUUID()}.json`);

describe("FileAgentTaskBoard — durable persistence (S2)", () => {
  it("a missing file reads as an empty board (never throws)", async () => {
    expect(await readBoard(join(dir, "ghost.json"))).toEqual([]);
  });
  it("round-trips: persisted tasks load back identically", async () => {
    const file = freshFile();
    const board = addTask([], { id: "a", title: "ship S2" }, "2026-06-28T00:00:00Z");
    await writeBoard(file, board);
    expect((await readBoard(file)).map((t) => t.id)).toEqual(["a"]);
    expect(JSON.parse(await readFile(file, "utf8")).tasks).toHaveLength(1);
  });
  it("mutate applies a pure transform AND persists it (the read-modify-write seam)", async () => {
    const store = new FileAgentTaskBoard(freshFile());
    await store.mutate((tasks) => addTask(tasks, { id: "a", title: "first" }, "t0"));
    const after = await store.mutate((tasks) => addTask(tasks, { id: "b", dependsOn: ["a"], title: "second" }, "t1"));
    expect(after.map((t) => t.id)).toEqual(["a", "b"]);
    expect((await new FileAgentTaskBoard((store as unknown as { file: string }).file).list()).map((t) => t.id)).toEqual(["a", "b"]); // survived a fresh handle
  });
  it("a corrupt file reads as empty, not a crash", async () => {
    const file = freshFile();
    await writeBoard(file, addTask([], { id: "a", title: "x" }, "t0"));
    await (await import("node:fs/promises")).writeFile(file, "{ not json");
    expect(await readBoard(file)).toEqual([]);
  });
  it("quarantines corrupt board data before mutation replaces it", async () => {
    const file = freshFile();
    const corruptContents = "{ not json";
    await writeFile(file, corruptContents, "utf8");

    const store = new FileAgentTaskBoard(file);
    await store.mutate((tasks) => addTask(tasks, { id: "recovered", title: "Recovered" }, "t0"));

    const quarantinePrefix = `${basename(file)}.corrupt-`;
    const quarantineFile = (await readdir(dirname(file))).find((entry) => entry.startsWith(quarantinePrefix));
    expect(quarantineFile).toBeDefined();
    expect(await readFile(join(dirname(file), quarantineFile!), "utf8")).toBe(corruptContents);
    expect((await readBoard(file)).map((task) => task.id)).toEqual(["recovered"]);
  });
  it("filters malformed persisted tasks and malformed run entries", async () => {
    const file = freshFile();
    await writeFile(file, JSON.stringify({
      tasks: [
        { createdAt: "t0", dependsOn: [], id: "good", runs: [{ at: "t1", status: "completed" }, { at: 42, status: "failed" }], status: "done", title: "Good", updatedAt: "t1" },
        { id: "missing-contract" }
      ]
    }), "utf8");
    const tasks = await readBoard(file);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "good", runs: [{ at: "t1", status: "completed" }] });
  });
  it("serializes concurrent mutations across board instances", async () => {
    const file = freshFile();
    const first = new FileAgentTaskBoard(file);
    const second = new FileAgentTaskBoard(file);
    await Promise.all([
      first.mutate((tasks) => addTask(tasks, { id: "first", title: "First" }, "t0")),
      second.mutate((tasks) => addTask(tasks, { id: "second", title: "Second" }, "t1"))
    ]);
    expect((await readBoard(file)).map((task) => task.id).sort()).toEqual(["first", "second"]);
  });
});

import { defaultBoardFile } from "../src/board-store.js";

describe("defaultBoardFile", () => {
  it("honors MUSE_BOARD_FILE; else falls back to a ~/.muse path", () => {
    expect(defaultBoardFile({ MUSE_BOARD_FILE: "/tmp/x/board.json" } as NodeJS.ProcessEnv)).toBe("/tmp/x/board.json");
    expect(defaultBoardFile({} as NodeJS.ProcessEnv)).toMatch(/\.muse[/\\]agent-board\.json$/u);
  });
});
