import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock("@muse/stores", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muse/stores")>();
  // Default to the real tolerant reader; individual tests override with a
  // one-shot rejection to reach the otherwise-unreachable catch branch
  // (the real reader never throws — missing/corrupt file degrades to []).
  readMock.mockImplementation(actual.readProactiveHistory);
  return { ...actual, readProactiveHistory: (file: string, limit?: number) => readMock(file, limit) };
});

import { createProactiveMcpServer } from "../src/loopback-proactive.js";
import type { ProactiveHistoryEntry } from "@muse/stores";

let dir: string;
let counter = 0;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "loopback-proactive-"));
  counter = 0;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const entry = (id: string): ProactiveHistoryEntry => ({
  destination: "C1",
  firedAtIso: "2026-01-01T00:00:00Z",
  itemId: id,
  kind: "calendar",
  providerId: "slack",
  startIso: "2026-01-01T00:00:00Z",
  status: "delivered",
  text: "your 3pm meeting starts soon",
  title: `event ${id}`
});

// Stored newest-LAST (readProactiveHistory reverses to newest-first).
const writeHistory = async (ids: readonly string[]): Promise<string> => {
  const file = join(dir, `history-${counter++}.json`);
  await fs.writeFile(file, JSON.stringify({ entries: ids.map(entry), version: 1 }));
  return file;
};

const historyTool = (file: string) => createProactiveMcpServer({ historyFile: file }).tools[0]!;

describe("createProactiveMcpServer — shape", () => {
  it("is the muse.proactive loopback server exposing a single read-only history tool", () => {
    const server = createProactiveMcpServer({ historyFile: join(dir, "x.json") });
    expect(server.name).toBe("muse.proactive");
    expect(server.description).toContain("Proactive surfacing audit");
    expect(server.tools).toHaveLength(1);
  });

  it("declares the history tool with a read risk, tasks domain, and a closed limit schema", () => {
    const tool = historyTool(join(dir, "x.json"));
    expect(tool.name).toBe("history");
    expect(tool.risk).toBe("read");
    expect(tool.domain).toBe("tasks");
    expect(tool.description).toContain("did the 3pm meeting notice land");
    expect(tool.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { limit: { type: "number" } },
      type: "object"
    });
  });
});

describe("history tool execute — newest-first audit with a clamped limit", () => {
  it("returns every entry newest-first with a matching total", async () => {
    const tool = historyTool(await writeHistory(["1", "2", "3"]));
    const result = await tool.execute({});
    expect(result.total).toBe(3);
    expect((result.entries as readonly ProactiveHistoryEntry[]).map((e) => e.itemId)).toEqual(["3", "2", "1"]);
  });

  it("returns an empty audit (total 0) for a missing history file", async () => {
    const result = await historyTool(join(dir, "absent.json")).execute({});
    expect(result).toEqual({ entries: [], total: 0 });
  });

  it("honours an explicit limit", async () => {
    const tool = historyTool(await writeHistory(["1", "2", "3"]));
    expect((await tool.execute({ limit: 2 })).total).toBe(2);
  });

  it("clamps a limit below 1 up to 1", async () => {
    const tool = historyTool(await writeHistory(["1", "2", "3"]));
    expect((await tool.execute({ limit: 0 })).total).toBe(1);
    expect((await tool.execute({ limit: -10 })).total).toBe(1);
  });

  it("truncates a fractional limit toward zero", async () => {
    const tool = historyTool(await writeHistory(["1", "2", "3"]));
    expect((await tool.execute({ limit: 2.9 })).total).toBe(2);
  });

  it("ignores a non-finite or non-number limit, falling back to the default", async () => {
    const tool = historyTool(await writeHistory(["1", "2", "3"]));
    expect((await tool.execute({ limit: Number.NaN })).total).toBe(3);
    expect((await tool.execute({ limit: Number.POSITIVE_INFINITY })).total).toBe(3);
    expect((await tool.execute({ limit: "2" as unknown as number })).total).toBe(3);
    expect((await tool.execute({})).total).toBe(3);
  });

  it("applies the default read limit (100) and caps an oversized limit at 500", async () => {
    const ids = Array.from({ length: 600 }, (_value, i) => String(i));
    const tool = historyTool(await writeHistory(ids));
    expect((await tool.execute({})).total).toBe(100);
    expect((await tool.execute({ limit: 1000 })).total).toBe(500);
  });
});

describe("history tool execute — defensive error path (reader throwing)", () => {
  it("returns the Error message when the history read rejects with an Error", async () => {
    readMock.mockRejectedValueOnce(new Error("disk exploded"));
    const result = await historyTool(join(dir, "x.json")).execute({});
    expect(result).toEqual({ error: "disk exploded" });
  });

  it("stringifies a non-Error rejection", async () => {
    readMock.mockRejectedValueOnce("weird failure");
    const result = await historyTool(join(dir, "x.json")).execute({});
    expect(result).toEqual({ error: "weird failure" });
  });
});
