import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPersonalThread } from "@muse/attunement";
import { afterEach, describe, expect, it } from "vitest";

import { createContinuityThreadListTool } from "../src/continuity-thread-list-tool.js";
import { createMuseRuntimeAssembly } from "../src/index.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

describe("normal-chat continuity thread list tool", () => {
  it("registers one read-only exact-empty schema and projects bounded thread identity without writes", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-tool-"));
    const file = join(directory, "attunement.json");
    await createPersonalThread(file, {
      kind: "life",
      title: `Return to dentist planning ${"x".repeat(600)}`
    }, {
      idFactory: () => "dentist",
      now: () => new Date("2026-07-28T00:00:00.000Z")
    });
    const before = await readFile(file);
    const assembly = createMuseRuntimeAssembly({
      env: { MUSE_ATTUNEMENT_FILE: file }
    });
    const matching = assembly.toolRegistry.list().filter(
      (tool) => tool.definition.name === "muse.continuity.threads.list"
    );

    expect(matching).toHaveLength(1);
    const tool = matching[0]!;
    expect(tool.definition).toMatchObject({
      inputSchema: {
        additionalProperties: false,
        properties: {},
        required: [],
        type: "object"
      },
      risk: "read"
    });
    expect(tool.definition.description).toContain("does not create/select");
    expect(tool.definition.description).toContain("record an outcome");

    const output = await tool.execute({}, { runId: "run_1" });
    expect(output).toEqual({
      count: 1,
      threads: [{
        id: "thread_dentist",
        kind: "life",
        title: `Return to dentist planning ${"x".repeat(472)}…`
      }],
      total: 1,
      truncated: false
    });
    expect(Object.keys((output as { threads: readonly Record<string, unknown>[] }).threads[0]!).sort())
      .toEqual(["id", "kind", "title"]);
    expect(await readFile(file)).toEqual(before);

    await expect(tool.execute(
      { create: true },
      { runId: "run_1" }
    )).rejects.toThrow(/accepts no arguments/u);
    expect(await readFile(file)).toEqual(before);
  });

  it("caps the projection at fifty rows without mutating the source", async () => {
    const source = Array.from({ length: 51 }, (_, index) => ({
      id: `thread_${index.toString()}`,
      kind: index % 2 === 0 ? "life" as const : "work" as const,
      title: `Thread ${index.toString()}`
    }));
    const before = JSON.stringify(source);
    let reads = 0;
    const tool = createContinuityThreadListTool({
      readThreads: async () => {
        reads += 1;
        return source;
      }
    });

    await expect(tool.execute({}, { runId: "run_1" })).resolves.toMatchObject({
      count: 50,
      total: 51,
      truncated: true
    });
    expect(reads).toBe(1);
    expect(JSON.stringify(source)).toBe(before);
  });
});
