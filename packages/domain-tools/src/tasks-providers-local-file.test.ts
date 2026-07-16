import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TasksProviderError, TasksValidationError } from "./tasks-providers.js";
import { LocalFileTasksProvider } from "./tasks-providers-local-file.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "muse-tasks-test-"));
  file = join(dir, "tasks.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeProvider(overrides: Partial<{ idFactory: () => string; now: () => Date; maxListEntries: number }> = {}): LocalFileTasksProvider {
  return new LocalFileTasksProvider({ file, ...overrides });
}

describe("LocalFileTasksProvider construction", () => {
  it("throws TasksValidationError for an empty file path", () => {
    expect(() => new LocalFileTasksProvider({ file: "" })).toThrow(TasksValidationError);
    expect(() => new LocalFileTasksProvider({ file: "   " })).toThrow(TasksValidationError);
  });

  it("rejects a non-finite list limit", () => {
    expect(() => makeProvider({ maxListEntries: Number.NaN })).toThrow(TasksValidationError);
    expect(() => makeProvider({ maxListEntries: Number.POSITIVE_INFINITY })).toThrow(TasksValidationError);
  });

  it("describes itself with the configured file path", () => {
    const provider = makeProvider();
    const info = provider.describe();
    expect(info.id).toBe("local");
    expect(info.local).toBe(true);
    expect(info.description).toContain(file);
  });
});

describe("LocalFileTasksProvider empty / missing store", () => {
  it("list() on a missing file returns empty, never throws", async () => {
    const provider = makeProvider();
    await expect(provider.list()).resolves.toEqual([]);
  });

  it("list('all') on a missing file also returns empty", async () => {
    const provider = makeProvider();
    await expect(provider.list("all")).resolves.toEqual([]);
  });
});

describe("LocalFileTasksProvider add/list round-trip", () => {
  it("preserves concurrent additions from separate provider instances", async () => {
    const first = makeProvider({ idFactory: () => "task_first" });
    const second = makeProvider({ idFactory: () => "task_second" });
    await Promise.all([first.add({ title: "First" }), second.add({ title: "Second" })]);
    const listed = await makeProvider().list("all");
    expect(listed.map((task) => task.id).sort()).toEqual(["task_first", "task_second"]);
  });

  it("adds a task and lists it back with the right shape", async () => {
    const clock = new Date("2026-01-01T00:00:00.000Z");
    const provider = makeProvider({ idFactory: () => "task_1", now: () => clock });
    const created = await provider.add({ title: "Buy milk" });
    expect(created).toMatchObject({ id: "task_1", providerId: "local", status: "open", title: "Buy milk" });
    expect(created.createdAt).toBeInstanceOf(Date);

    const listed = await provider.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "task_1", title: "Buy milk", status: "open" });
  });

  it("persists notes and tags only when provided (no empty-array/blank leakage)", async () => {
    const provider = makeProvider({ idFactory: () => "task_1" });
    const withExtras = await provider.add({ notes: "2%", tags: ["errand"], title: "Buy milk" });
    expect(withExtras.notes).toBe("2%");
    expect(withExtras.tags).toEqual(["errand"]);

    const bare = await provider.add({ title: "Bare task" });
    expect(bare.notes).toBeUndefined();
    expect(bare.tags).toBeUndefined();
  });

  it("rejects an empty or whitespace-only title without writing", async () => {
    const provider = makeProvider();
    await expect(provider.add({ title: "" })).rejects.toThrow(TasksValidationError);
    await expect(provider.add({ title: "   " })).rejects.toThrow(TasksValidationError);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("list returns newest-first (createdAt descending)", async () => {
    const times = ["2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z", "2026-01-02T00:00:00.000Z"];
    let i = 0;
    const provider = makeProvider({ idFactory: () => `task_${(i + 1).toString()}`, now: () => new Date(times[i++] ?? "") });
    await provider.add({ title: "first" });
    await provider.add({ title: "second" });
    await provider.add({ title: "third" });
    const listed = await provider.list("all");
    expect(listed.map((t) => t.title)).toEqual(["second", "third", "first"]);
  });

  it("list caps at maxListEntries", async () => {
    const provider = makeProvider({ idFactory: () => `id_${Math.random().toString()}`, maxListEntries: 2 });
    await provider.add({ title: "a" });
    await provider.add({ title: "b" });
    await provider.add({ title: "c" });
    const listed = await provider.list("all");
    expect(listed).toHaveLength(2);
  });

  it("list filters by status", async () => {
    let id = 0;
    const provider = makeProvider({ idFactory: () => `task_${(id++).toString()}` });
    const a = await provider.add({ title: "open one" });
    await provider.add({ title: "open two" });
    await provider.complete(a.id);

    const open = await provider.list("open");
    const done = await provider.list("done");
    expect(open.map((t) => t.title)).toEqual(["open two"]);
    expect(done.map((t) => t.title)).toEqual(["open one"]);
  });
});

describe("LocalFileTasksProvider complete", () => {
  it("marks a task done and sets completedAt", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const provider = makeProvider({ idFactory: () => "task_1", now: () => clock });
    const created = await provider.add({ title: "Ship it" });
    clock = new Date("2026-01-02T00:00:00.000Z");
    const completed = await provider.complete(created.id);
    expect(completed?.status).toBe("done");
    expect(completed?.completedAt).toEqual(new Date("2026-01-02T00:00:00.000Z"));
  });

  it("is idempotent — completing an already-done task leaves completedAt untouched", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const provider = makeProvider({ idFactory: () => "task_1", now: () => clock });
    const created = await provider.add({ title: "Ship it" });
    clock = new Date("2026-01-02T00:00:00.000Z");
    const firstComplete = await provider.complete(created.id);
    clock = new Date("2026-01-03T00:00:00.000Z");
    const secondComplete = await provider.complete(created.id);
    expect(secondComplete?.completedAt).toEqual(firstComplete?.completedAt);
  });

  it("returns undefined for an unknown id", async () => {
    const provider = makeProvider();
    await expect(provider.complete("nope")).resolves.toBeUndefined();
  });

  it("rejects an empty id", async () => {
    const provider = makeProvider();
    await expect(provider.complete("")).rejects.toThrow(TasksValidationError);
  });
});

describe("LocalFileTasksProvider search", () => {
  it("matches title and notes case-insensitively, returning notes as snippet", async () => {
    let id = 0;
    const provider = makeProvider({ idFactory: () => `task_${(id++).toString()}` });
    await provider.add({ title: "Buy Milk" });
    await provider.add({ notes: "Remember the OAT milk", title: "Groceries" });
    await provider.add({ title: "Unrelated" });

    const hits = await provider.search("milk", 10);
    expect(hits).toHaveLength(2);
    const byTitle = hits.find((h) => h.title === "Buy Milk");
    expect(byTitle?.snippet).toBeUndefined();
    const byNotes = hits.find((h) => h.title === "Groceries");
    expect(byNotes?.snippet).toBe("Remember the OAT milk");
  });

  it("rejects an empty query", async () => {
    const provider = makeProvider();
    await expect(provider.search("", 10)).rejects.toThrow(TasksValidationError);
    await expect(provider.search("   ", 10)).rejects.toThrow(TasksValidationError);
  });

  it("caps hits at the requested limit", async () => {
    let id = 0;
    const provider = makeProvider({ idFactory: () => `task_${(id++).toString()}` });
    for (let n = 0; n < 5; n += 1) {
      await provider.add({ title: `match ${n.toString()}` });
    }
    const hits = await provider.search("match", 2);
    expect(hits).toHaveLength(2);
  });
});

describe("LocalFileTasksProvider corrupt / malformed store", () => {
  it("treats a garbage (non-JSON) file as empty, never throws", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, "not json at all {{{", "utf8");
    const provider = makeProvider();
    await expect(provider.list()).resolves.toEqual([]);
  });

  it("treats valid JSON with the wrong shape (no tasks array) as empty", async () => {
    await fs.writeFile(file, JSON.stringify({ notTasks: [] }), "utf8");
    const provider = makeProvider();
    await expect(provider.list()).resolves.toEqual([]);
  });

  it("filters out individually malformed entries within an otherwise valid tasks array", async () => {
    await fs.writeFile(file, JSON.stringify({
      tasks: [
        { createdAt: "2026-01-01T00:00:00.000Z", id: "good", status: "open", title: "Good task" },
        { id: "bad-no-title", status: "open" },
        { id: "bad-status", status: "unknown", title: "Bad status", createdAt: "2026-01-01T00:00:00.000Z" }
      ]
    }), "utf8");
    const provider = makeProvider();
    const listed = await provider.list("all");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("good");
  });

  it("quarantines corrupt source bytes before creating a clean replacement store", async () => {
    await fs.writeFile(file, "{{{garbage", "utf8");
    const provider = makeProvider({ idFactory: () => "task_1" });
    await provider.add({ title: "Recovered task" });
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { tasks: unknown[] };
    expect(parsed.tasks).toHaveLength(1);
    const preservedContents = await Promise.all(
      (await fs.readdir(dir))
        .filter((name) => name !== "tasks.json")
        .map(async (name) => fs.readFile(join(dir, name), "utf8").catch(() => ""))
    );
    expect(preservedContents).toContain("{{{garbage");
  });
});

describe("LocalFileTasksProvider write-failure leaves no partial state", () => {
  it.skipIf(process.platform === "win32")("a failed write throws TasksProviderError and does not corrupt the existing file", async () => {
    const provider = makeProvider({ idFactory: () => "task_1" });
    await provider.add({ title: "Existing task" });
    const before = await fs.readFile(file, "utf8");

    // Force the rename step to fail by making the target file's directory
    // read-only is unreliable across platforms; instead simulate by making
    // the destination path a directory so `fs.rename` onto it fails, while
    // the original store is untouched because writeTasks writes to a tmp
    // file first and only renames at the very end.
    const provider2 = makeProvider({ idFactory: () => "task_2" });
    // Sabotage: point maxListEntries provider at a path where the tmp write succeeds
    // but rename fails, by replacing the target file with a directory of the same name
    // is not reversible for this test's given `file` (already a real file). Instead,
    // verify write-failure atomicity by asserting the tmp-file naming contract directly:
    // writeTasks always writes tmp then renames, so a mid-write crash (simulated by
    // reading the file immediately after a throwing write attempt) never sees a partial file.
    await fs.chmod(dir, 0o500);
    try {
      await expect(provider2.add({ title: "Should fail" })).rejects.toThrow(TasksProviderError);
    } finally {
      await fs.chmod(dir, 0o700);
    }
    const after = await fs.readFile(file, "utf8");
    expect(after).toBe(before);
    // No stray tmp file left behind from the failed attempt.
    const entries = await fs.readdir(dir);
    expect(entries.every((name) => !name.includes(".tmp-"))).toBe(true);
  });
});

describe("LocalFileTasksProvider mutation check (teeth)", () => {
  it.skipIf(process.platform === "win32")("would fail if add() silently swallowed a write error instead of throwing TasksProviderError", async () => {
    // This asserts the *contract*: add() must propagate write failures as
    // TasksProviderError, not resolve successfully. Flip the source's catch
    // block to `return this.toTask(created);` (swallow) and this test goes RED.
    const provider = makeProvider({ idFactory: () => "task_1" });
    await fs.chmod(dir, 0o500);
    try {
      await expect(provider.add({ title: "x" })).rejects.toThrow(TasksProviderError);
    } finally {
      await fs.chmod(dir, 0o700);
    }
  });
});
