import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAttunementState } from "@muse/attunement";
import { afterEach, describe, expect, it } from "vitest";

import { createMuseRuntimeAssembly } from "../src/index.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

describe("normal-chat continuity thread create tool", () => {
  it("registers one write-risk exact schema and creates one unlinked approved thread", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-create-"));
    const file = join(directory, "attunement.json");
    const assembly = createMuseRuntimeAssembly({
      env: { HOME: directory, MUSE_ATTUNEMENT_FILE: file }
    });
    const matching = assembly.toolRegistry.list().filter(
      (tool) => tool.definition.name === "muse.continuity.thread.create"
    );

    expect(matching).toHaveLength(1);
    const tool = matching[0]!;
    expect(tool.definition).toMatchObject({
      inputSchema: {
        additionalProperties: false,
        properties: {
          kind: { enum: ["life", "work"], type: "string" },
          title: { maxLength: 500, minLength: 1, type: "string" }
        },
        required: ["kind", "title"],
        type: "object"
      },
      risk: "write"
    });
    expect(tool.definition.description).toContain("pending suggestion");
    expect(tool.definition.description).toContain("explicitly approves");

    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(tool.execute(
      { kind: "work", title: "Ship provider-neutral daily loop" },
      { runId: "approved_1" }
    )).resolves.toEqual({
      created: true,
      linksCreated: 0,
      success: true,
      thread: {
        id: expect.stringMatching(/^thread_/u),
        kind: "work",
        title: "Ship provider-neutral daily loop"
      }
    });

    const state = await readAttunementState(file);
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0]).toMatchObject({
      kind: "work",
      links: [],
      title: "Ship provider-neutral daily loop"
    });
  });

  it("fails closed on ambiguous, accessor, or extra input without creating the store", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-create-invalid-"));
    const file = join(directory, "attunement.json");
    const tool = createMuseRuntimeAssembly({
      env: { HOME: directory, MUSE_ATTUNEMENT_FILE: file }
    }).toolRegistry.list().find(
      (candidate) => candidate.definition.name === "muse.continuity.thread.create"
    )!;
    let getterReads = 0;
    const accessor = Object.defineProperty(
      { kind: "life" },
      "title",
      {
        enumerable: true,
        get: () => {
          getterReads += 1;
          return "Hidden title";
        }
      }
    );

    await expect(tool.execute(
      { kind: "personal", title: "Ambiguous kind" },
      { runId: "invalid_1" }
    )).rejects.toThrow(/exactly life or work/u);
    await expect(tool.execute(
      { kind: "life", title: " Trimmed by implementation " },
      { runId: "invalid_2" }
    )).rejects.toThrow(/no surrounding whitespace/u);
    await expect(tool.execute(
      { kind: "life", title: "No extras", link: "task_1" },
      { runId: "invalid_3" }
    )).rejects.toThrow(/exactly kind and title/u);
    await expect(tool.execute(
      accessor,
      { runId: "invalid_4" }
    )).rejects.toThrow(/plain data property/u);

    expect(getterReads).toBe(0);
    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
