import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { registerNoteRelationsCommands } from "./commands-note-relations.js";
import { COMMAND_STUBS } from "./command-manifest.js";
import { readNoteRelationsStore, resolveNoteRelationsPathSnapshot } from "./note-relations-store.js";

async function cliFixture() {
  const home = await mkdtemp(join(tmpdir(), "muse-relations-cli-"));
  const paths = resolveNoteRelationsPathSnapshot({ HOME: home });
  await mkdir(paths.notesDir, { recursive: true, mode: 0o700 });
  const sourcePath = join(paths.notesDir, "facts.md");
  const source = "Current answer\n\nUsed to be old answer";
  await writeFile(sourcePath, source, { mode: 0o600 });
  await writeFile(paths.notesIndexFile, JSON.stringify({
    version: 2,
    model: "fixture",
    builtAtIso: "2026-07-21T00:00:00.000Z",
    embeddingCount: 2,
    embeddingDim: 3,
    files: [{
      path: sourcePath,
      mtimeMs: 1,
      sourceHash: createHash("sha256").update(source).digest("hex"),
      chunkerVersion: "muse.notes.chunk-text.v1",
      chunks: [
        { file: sourcePath, chunkIndex: 0, text: "Current answer" },
        { file: sourcePath, chunkIndex: 1, text: "Used to be old answer" }
      ]
    }]
  }), { mode: 0o600 });
  return { home, paths, sourcePath };
}

function createHarness(home: string, overrides: Parameters<typeof registerNoteRelationsCommands>[2] = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command();
  program.exitOverride();
  program.command("notes");
  registerNoteRelationsCommands(program, {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message)
  }, {
    env: { HOME: home },
    isTTY: () => false,
    now: () => new Date("2026-07-21T00:00:00.000Z"),
    randomEdgeId: () => "1".repeat(32),
    ...overrides
  });
  return { program, stderr, stdout };
}

async function run(program: Command, args: string[]) {
  process.exitCode = undefined;
  await program.parseAsync(["node", "muse", ...args]);
}

const ADD_ARGS = [
  "notes", "relations", "add",
  "--current-source", "facts.md", "--current-chunk", "0", "--current-start", "0", "--current-end", "14",
  "--stale-source", "facts.md", "--stale-chunk", "1", "--stale-start", "0", "--stale-end", "21"
];

afterEach(() => { process.exitCode = undefined; });

describe("direct note relations CLI", () => {
  it("inspects exact relative chunks and never exposes an owner absolute path", async () => {
    const { home } = await cliFixture();
    const harness = createHarness(home);
    await run(harness.program, ["notes", "relations", "inspect", "--source", "facts.md", "--chunk", "0", "--start", "0", "--end", "7", "--json"]);
    expect(harness.stderr).toEqual([]);
    const output = JSON.parse(harness.stdout.join("")) as Record<string, unknown>;
    expect(output).toMatchObject({ ok: true, command: "inspect", data: { source: "facts.md" } });
    expect(harness.stdout.join("")).not.toContain(home);
  });

  it("keeps validation failures inside the one-object JSON envelope", async () => {
    const { home } = await cliFixture();
    const harness = createHarness(home);
    await run(harness.program, ["notes", "relations", "inspect", "--json"]);
    expect(harness.stdout).toHaveLength(1);
    expect(JSON.parse(harness.stdout[0]!)).toEqual({
      ok: false,
      command: "inspect",
      error: { code: "INVALID_REFERENCE", message: "invalid reference" }
    });
    expect(process.exitCode).toBe(2);
  });

  it("requires explicit non-TTY JSON confirmation and writes zero", async () => {
    const { home, paths } = await cliFixture();
    const harness = createHarness(home);
    await run(harness.program, [...ADD_ARGS, "--json"]);
    expect(JSON.parse(harness.stdout.join(""))).toEqual({
      ok: false,
      command: "add",
      error: { code: "CONFIRMATION_REQUIRED", message: "confirmation required" }
    });
    expect(process.exitCode).toBe(2);
    expect((await readNoteRelationsStore(paths)).state).toBe("absent");
  });

  it("adds, lists, shows, audits, and explicitly removes one relation", async () => {
    const { home, paths, sourcePath } = await cliFixture();
    const add = createHarness(home);
    await run(add.program, [...ADD_ARGS, "--yes", "--json"]);
    expect(JSON.parse(add.stdout.join(""))).toMatchObject({ ok: true, command: "add", data: { edgeId: "1".repeat(32), revision: 1 } });

    for (const [leaf, expected] of [["list", "valid"], ["audit", "valid"]] as const) {
      const harness = createHarness(home);
      await run(harness.program, ["notes", "relations", leaf, "--json"]);
      expect(JSON.parse(harness.stdout.join(""))).toMatchObject({ ok: true, command: leaf, data: { state: expected } });
    }
    const show = createHarness(home);
    await run(show.program, ["notes", "relations", "show", "1".repeat(32), "--json"]);
    expect(JSON.parse(show.stdout.join(""))).toMatchObject({ ok: true, command: "show", data: { relation: { edgeId: "1".repeat(32) } } });

    await writeFile(sourcePath, "Source was deleted or changed", { mode: 0o600 });
    const remove = createHarness(home);
    await run(remove.program, ["notes", "relations", "remove", "1".repeat(32), "--yes", "--json"]);
    expect(JSON.parse(remove.stdout.join(""))).toMatchObject({ ok: true, command: "remove", data: { revision: 2 } });
    expect((await readNoteRelationsStore(paths)).relations).toEqual([]);
  });

  it("fails closed when the source changes after interactive confirmation", async () => {
    for (let trial = 0; trial < 3; trial += 1) {
      const { home, paths, sourcePath } = await cliFixture();
      const harness = createHarness(home, {
        isTTY: () => true,
        confirm: async () => {
          await writeFile(sourcePath, `Changed during prompt ${trial.toString()}`, { mode: 0o600 });
          return true;
        }
      });
      await run(harness.program, ADD_ARGS);
      expect(harness.stderr.join("")).toContain("confirmation stale");
      expect(process.exitCode).toBe(1);
      expect((await readNoteRelationsStore(paths)).state).toBe("absent");
    }
  });

  it("freezes one relation-store target across confirmation pass^3", async () => {
    for (let trial = 0; trial < 3; trial += 1) {
      const { home } = await cliFixture();
      const env: Record<string, string | undefined> = {
        HOME: home,
        MUSE_NOTE_RELATIONS_FILE: join(home, ".muse", `a-${trial.toString()}.json`)
      };
      const original = resolveNoteRelationsPathSnapshot(env);
      const redirectedFile = join(home, ".muse", `b-${trial.toString()}.json`);
      const harness = createHarness(home, {
        env,
        isTTY: () => true,
        confirm: async () => {
          env.MUSE_NOTE_RELATIONS_FILE = redirectedFile;
          return true;
        }
      });
      await run(harness.program, ADD_ARGS);
      expect((await readNoteRelationsStore(original)).relations).toHaveLength(1);
      expect((await readNoteRelationsStore(resolveNoteRelationsPathSnapshot(env))).state).toBe("absent");
    }
  });

  it("refuses an add that would reuse an existing graph endpoint", async () => {
    const { home, paths } = await cliFixture();
    const first = createHarness(home);
    await run(first.program, [...ADD_ARGS, "--yes", "--json"]);
    const second = createHarness(home, { randomEdgeId: () => "2".repeat(32) });
    await run(second.program, [...ADD_ARGS, "--yes", "--json"]);
    expect(JSON.parse(second.stdout.join(""))).toMatchObject({
      ok: false,
      command: "add",
      error: { code: "GRAPH_UNAVAILABLE" }
    });
    expect(process.exitCode).toBe(1);
    expect((await readNoteRelationsStore(paths)).revision).toBe(1);
  });

  it("keeps --yes limited to the two direct mutation leaves", async () => {
    const { home } = await cliFixture();
    const { program } = createHarness(home);
    const notes = program.commands.find((command) => command.name() === "notes")!;
    const relations = notes.commands.find((command) => command.name() === "relations")!;
    const withYes = relations.commands.filter((command) => command.options.some((option) => option.long === "--yes")).map((command) => command.name()).sort();
    expect(withYes).toEqual(["add", "remove"]);
  });

  it("does not expose temporal relation mutation through MCP, tools, API, slash commands, or a top-level command", async () => {
    expect(COMMAND_STUBS.some((stub) => stub.name === "relations")).toBe(false);
    const root = new URL("../../..", import.meta.url);
    const files: URL[] = [];
    const collect = async (directory: URL): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
        if (entry.isDirectory()) await collect(child);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(child);
      }
    };
    for (const relative of ["apps/api/src/", "packages/mcp/src/", "packages/tools/src/", "packages/autoconfigure/src/"]) {
      await collect(new URL(relative, root));
    }
    const slashFiles = (await readdir(new URL("apps/cli/src/", root), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.includes("slash") && entry.name.endsWith(".ts"))
      .map((entry) => new URL(`apps/cli/src/${entry.name}`, root));
    const text = (await Promise.all([...files, ...slashFiles].map((file) => readFile(file, "utf8")))).join("\n");
    expect(text).not.toMatch(/registerNoteRelationsCommands|muse\.note-relations\.store\.v1|notes relations/iu);
  });
});
