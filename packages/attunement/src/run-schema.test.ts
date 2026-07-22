import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeLocalCheckpointReference, encodeLocalRunReference } from "@muse/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createPersonalThread, readAttunementState } from "./attunement-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

function state(schemaVersion: number, links: readonly unknown[] = []) {
  return {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion,
    threads: links.length === 0 ? [] : [{ createdAt: "2026-07-22T00:00:00.000Z", id: "thread_1", kind: "work", links, policy: { detail: "standard", nextStep: "direct", suppression: "none", version: 0 }, title: "Release" }],
    undoResetReceipts: []
  };
}

async function storeFile() {
  const root = await mkdtemp(join(tmpdir(), "muse-attunement-run-schema-"));
  roots.push(root);
  return join(root, "attunement.json");
}

describe("Attunement schema v8 checkpoint references", () => {
  it("reads v7 byte-stably and migrates only on explicit mutation", async () => {
    const file = await storeFile();
    const raw = `${JSON.stringify(state(7), null, 2)}\n`;
    await writeFile(file, raw, "utf8");
    expect(await readAttunementState(file)).toMatchObject({ schemaVersion: 11 });
    expect(await readFile(file, "utf8")).toBe(raw);
    await createPersonalThread(file, { kind: "work", title: "Release" }, { idFactory: () => "thread_new", now: () => new Date("2026-07-22T00:00:00.000Z") });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ schemaVersion: 11 });
  });

  it("rejects a run reference in v6 and a malformed run locator in v7 byte-stably", async () => {
    const file = await storeFile();
    const reference = encodeLocalRunReference({ runId: "run_exact", workspaceRealpath: "/Users/example/project" });
    for (const [schemaVersion, artifactId] of [[6, reference], [7, "muse-run-v1:not-canonical"]] as const) {
      const raw = `${JSON.stringify(state(schemaVersion, [{ artifactId, artifactType: "run", linkedAt: "2026-07-22T00:00:00.000Z", linkedBy: "user", providerId: "local", role: "context", threadId: "thread_1" }]), null, 2)}\n`;
      await writeFile(file, raw, "utf8");
      await expect(readAttunementState(file)).rejects.toThrow(/invalid/u);
      expect(await readFile(file, "utf8")).toBe(raw);
    }
  });

  it("rejects crafted checkpoint links in v7 and malformed locators in v8 without laundering bytes", async () => {
    const file = await storeFile();
    const reference = encodeLocalCheckpointReference({ runId: "run_exact", step: 1, workspaceRealpath: "/Users/example/project" });
    for (const [schemaVersion, artifactId] of [[7, reference], [8, "muse-checkpoint-v1:not-canonical"]] as const) {
      const raw = `${JSON.stringify(state(schemaVersion, [{ artifactId, artifactType: "checkpoint", linkedAt: "2026-07-22T00:00:00.000Z", linkedBy: "user", providerId: "local", role: "context", threadId: "thread_1" }]), null, 2)}\n`;
      await writeFile(file, raw, "utf8");
      await expect(readAttunementState(file)).rejects.toThrow(/invalid/u);
      await expect(createPersonalThread(file, { kind: "work", title: "No laundering" })).rejects.toThrow(/invalid/u);
      expect(await readFile(file, "utf8")).toBe(raw);
    }
  });
});
