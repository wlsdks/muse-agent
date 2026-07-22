import { spawn } from "node:child_process";
import { access, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { mutateNoteRelationsStore, readNoteRelationsStore, resolveNoteRelationsPathSnapshot } from "./note-relations-store.js";

const WORKER = String.raw`
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const { mutateNoteRelationsStore, resolveNoteRelationsPathSnapshot } = await import(process.argv[1]);
const [home, action, relationRaw, readyFile, delayRaw] = process.argv.slice(2);
const relation = JSON.parse(relationRaw);
const paths = resolveNoteRelationsPathSnapshot({ HOME: home });
await mutateNoteRelationsStore(paths, async (store) => {
  await writeFile(readyFile, "ready", { mode: 0o600 });
  await delay(Number(delayRaw));
  return action === "add"
    ? [...store.relations, relation]
    : store.relations.filter((candidate) => candidate.edgeId !== relation.edgeId);
});
`;

function relation(edgeDigit: string) {
  const identity = (role: string, digest: string) => ({
    schema: "muse.note-span.v1" as const,
    sourcePath: `${edgeDigit}-${role}.md`,
    sourceHash: digest.repeat(64),
    notesIndexSchema: 2 as const,
    chunkerVersion: "muse.notes.chunk-text.v1" as const,
    sourceIndexDigest: "b".repeat(64),
    chunkIndex: 0,
    chunkHash: "c".repeat(64),
    start: 0,
    end: 4,
    spanHash: "d".repeat(64)
  });
  return {
    schema: "muse.note-relation.supersedes.v1" as const,
    edgeId: edgeDigit.repeat(32),
    authoredAt: "2026-07-21T00:00:00.000Z",
    current: identity("current", edgeDigit),
    stale: identity("stale", edgeDigit === "1" ? "e" : "f")
  };
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error("child mutation did not acquire the lock");
}

async function child(home: string, action: "add" | "remove", value: ReturnType<typeof relation>, ready: string, delayMs: number) {
  const moduleUrl = new URL("./note-relations-store.ts", import.meta.url).href;
  const spawned = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval", WORKER,
    moduleUrl, home, action, JSON.stringify(value), ready, delayMs.toString()
  ], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  spawned.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return {
    completion: new Promise<void>((resolve, reject) => spawned.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)))),
    ready
  };
}

describe("note relations cross-process serialization", () => {
  it("preserves add/add and add/remove updates across real child processes pass^5", async () => {
    for (let trial = 0; trial < 5; trial += 1) {
      const addHome = await mkdtemp(join(tmpdir(), `muse-relations-child-add-${trial.toString()}-`));
      const firstReady = join(addHome, "first-ready");
      const first = await child(addHome, "add", relation("1"), firstReady, 80);
      await waitFor(firstReady);
      const second = await child(addHome, "add", relation("2"), join(addHome, "second-ready"), 0);
      await Promise.all([first.completion, second.completion]);
      const addStore = await readNoteRelationsStore(resolveNoteRelationsPathSnapshot({ HOME: addHome }));
      expect(addStore.relations.map((edge) => edge.edgeId)).toEqual(["1".repeat(32), "2".repeat(32)]);
      expect(addStore.revision).toBe(2);
      expect((await readdir(resolveNoteRelationsPathSnapshot({ HOME: addHome }).museRoot)).filter((name) => name !== "note-relations.json")).toEqual([]);

      const mixedHome = await mkdtemp(join(tmpdir(), `muse-relations-child-mixed-${trial.toString()}-`));
      const mixedPaths = resolveNoteRelationsPathSnapshot({ HOME: mixedHome });
      await mutateNoteRelationsStore(mixedPaths, () => [relation("1")]);
      const addReady = join(mixedHome, "add-ready");
      const add = await child(mixedHome, "add", relation("2"), addReady, 80);
      await waitFor(addReady);
      const remove = await child(mixedHome, "remove", relation("1"), join(mixedHome, "remove-ready"), 0);
      await Promise.all([add.completion, remove.completion]);
      const mixedStore = await readNoteRelationsStore(mixedPaths);
      expect(mixedStore.relations.map((edge) => edge.edgeId)).toEqual(["2".repeat(32)]);
      expect(mixedStore.revision).toBe(3);
      expect((await readdir(mixedPaths.museRoot)).filter((name) => name !== "note-relations.json")).toEqual([]);
    }
  }, 60_000);
});
