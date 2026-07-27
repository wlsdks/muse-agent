import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultBeliefProvenanceFile, FileUserMemoryStore, readBeliefProvenance } from "@muse/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";

function captureOutput() {
  const output: string[] = [];
  return {
    io: {
      readPipedStdin: async () => "",
      stderr: (message: string) => output.push(message),
      stdout: (message: string) => output.push(message)
    },
    output
  };
}

describe("muse memory exact owner controls", () => {
  let priorFile: string | undefined;
  let priorHome: string | undefined;
  let priorUser: string | undefined;
  let priorExitCode: number | string | null | undefined;
  let file: string;

  beforeEach(async () => {
    priorFile = process.env.MUSE_USER_MEMORY_FILE;
    priorHome = process.env.HOME;
    priorUser = process.env.MUSE_USER_ID;
    priorExitCode = process.exitCode;
    const dir = await mkdtemp(join(tmpdir(), "muse-cli-memory-owner-"));
    file = join(dir, "user-memory.json");
    process.env.HOME = dir;
    process.env.MUSE_USER_MEMORY_FILE = file;
    process.env.MUSE_USER_ID = "owner";
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (priorFile === undefined) delete process.env.MUSE_USER_MEMORY_FILE;
    else process.env.MUSE_USER_MEMORY_FILE = priorFile;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorUser === undefined) delete process.env.MUSE_USER_ID;
    else process.env.MUSE_USER_ID = priorUser;
    process.exitCode = priorExitCode;
  });

  it("runs inspect, read-only preview, correct, confirmed forget, and undo through exact IDs", async () => {
    const store = new FileUserMemoryStore({ file });
    await store.upsertFact("owner", "home_city", "Seoul");
    await store.upsertFact("owner", "timezone", "Asia/Seoul");

    const { io, output } = captureOutput();
    const program = createProgram(io);
    await program.parseAsync(["node", "muse", "memory", "inspect", "--json"], { from: "node" });
    const entries = JSON.parse(output.join("")) as Array<{
      exactId: string;
      key: string;
      value: string;
      version: number;
    }>;
    const city = entries.find((entry) => entry.key === "home_city")!;
    expect(city).toMatchObject({ value: "Seoul", version: 1 });

    output.length = 0;
    const beforePreview = await readFile(file, "utf8");
    await program.parseAsync(
      ["node", "muse", "memory", "preview", city.exactId, "--json"],
      { from: "node" }
    );
    expect(JSON.parse(output.join(""))).toMatchObject(city);
    expect(await readFile(file, "utf8")).toBe(beforePreview);

    output.length = 0;
    await program.parseAsync([
      "node", "muse", "memory", "correct", city.exactId, "Busan",
      "--expected-version", "1", "--request-id", "cli-correct-city-0001", "--json"
    ], { from: "node" });
    const corrected = JSON.parse(output.join("")) as { receiptId: string };
    expect((await store.previewOwnerMemory("owner", city.exactId))).toMatchObject({
      value: "Busan",
      version: 2
    });
    output.length = 0;
    await program.parseAsync([
      "node", "muse", "memory", "correct", city.exactId, "Busan",
      "--expected-version", "1", "--request-id", "cli-correct-city-0001", "--json"
    ], { from: "node" });
    expect(JSON.parse(output.join(""))).toMatchObject({ receiptId: corrected.receiptId });
    expect((await readBeliefProvenance(defaultBeliefProvenanceFile()))
      .filter((entry) => entry.key === "home_city" && entry.value === "Busan")).toHaveLength(1);

    output.length = 0;
    await program.parseAsync([
      "node", "muse", "memory", "forget", city.exactId,
      "--expected-version", "2", "--confirm", "mem_v1_00000000000000000000000000000000"
    ], { from: "node" });
    expect(process.exitCode).toBe(2);
    expect(output.join("")).toContain("--confirm must exactly match");
    expect((await store.findByUserId("owner"))?.facts.home_city).toBe("Busan");

    process.exitCode = undefined;
    output.length = 0;
    await program.parseAsync([
      "node", "muse", "memory", "forget", city.exactId,
      "--expected-version", "2", "--confirm", city.exactId,
      "--request-id", "cli-forget-city-0001", "--json"
    ], { from: "node" });
    const forgotten = JSON.parse(output.join("")) as { receiptId: string };
    expect((await store.findByUserId("owner"))?.facts.home_city).toBeUndefined();
    expect((await store.findByUserId("owner"))?.facts.timezone).toBe("Asia/Seoul");
    output.length = 0;
    await program.parseAsync([
      "node", "muse", "memory", "forget", city.exactId,
      "--expected-version", "2", "--confirm", city.exactId,
      "--request-id", "cli-forget-city-0001", "--json"
    ], { from: "node" });
    expect(JSON.parse(output.join(""))).toMatchObject({ receiptId: forgotten.receiptId });
    expect((await readBeliefProvenance(defaultBeliefProvenanceFile()))
      .filter((entry) => entry.key === "home_city" && entry.retraction === true)).toHaveLength(1);

    output.length = 0;
    await program.parseAsync(
      ["node", "muse", "memory", "undo", forgotten.receiptId, "--json"],
      { from: "node" }
    );
    expect(JSON.parse(output.join(""))).toMatchObject({
      receiptId: forgotten.receiptId,
      status: "undone"
    });
    output.length = 0;
    await program.parseAsync(
      ["node", "muse", "memory", "undo", forgotten.receiptId, "--json"],
      { from: "node" }
    );
    expect((await readBeliefProvenance(defaultBeliefProvenanceFile()))
      .filter((entry) => entry.key === "home_city" && entry.value === "Busan")).toHaveLength(2);
    expect((await store.previewOwnerMemory("owner", city.exactId))).toMatchObject({
      value: "Busan",
      version: 4
    });

    output.length = 0;
    await program.parseAsync(
      ["node", "muse", "memory", "undo", corrected.receiptId, "--json"],
      { from: "node" }
    );
    expect(process.exitCode).toBe(2);
    expect(output.join("")).toContain("refusing undo");
    expect((await store.findByUserId("owner"))?.facts.home_city).toBe("Busan");
  });

  it("rejects fuzzy display keys before any mutation", async () => {
    const store = new FileUserMemoryStore({ file });
    await store.upsertFact("owner", "home_city", "Seoul");
    const before = await readFile(file, "utf8");
    const { io, output } = captureOutput();
    const program = createProgram(io);

    await program.parseAsync(
      ["node", "muse", "memory", "preview", "Home City"],
      { from: "node" }
    );
    expect(process.exitCode).toBe(2);
    expect(output.join("")).toContain("exact-id-required");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("refuses legacy top-level forget and local set overwrite bypasses", async () => {
    const store = new FileUserMemoryStore({ file });
    await store.upsertFact("owner", "home_city", "Seoul");
    const before = await readFile(file, "utf8");
    const { io, output } = captureOutput();
    const program = createProgram(io);

    await program.parseAsync(["node", "muse", "forget", "home_city"], { from: "node" });
    expect(process.exitCode).toBe(2);
    expect(output.join("")).toContain("Single-entry deletion by display key is no longer allowed");
    expect(await readFile(file, "utf8")).toBe(before);

    process.exitCode = undefined;
    output.length = 0;
    await program.parseAsync([
      "node", "muse", "memory", "set", "fact", "Home City", "Busan", "--local"
    ], { from: "node" });
    expect(process.exitCode).toBe(2);
    expect(output.join("")).toContain("already exists");
    expect(output.join("")).toContain("muse memory correct");
    expect(await readFile(file, "utf8")).toBe(before);
  });
});
