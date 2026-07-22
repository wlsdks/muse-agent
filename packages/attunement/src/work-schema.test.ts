import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readAttunementState } from "./attunement-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

const ID = "work_123e4567-e89b-4d3a-a456-426614174000";

describe("Attunement schema v11 Work references", () => {
  it("rejects Work in v10, accepts it in v11, and rejects a global duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-work-schema-"));
    roots.push(root);
    const file = join(root, "attunement.json");
    const link = { artifactId: ID, artifactType: "work", linkedAt: "2026-07-22T00:00:00.000Z", linkedBy: "user", providerId: "local", role: "context", threadId: "thread_1" };
    const thread = { createdAt: "2026-07-22T00:00:00.000Z", id: "thread_1", kind: "work", links: [link], policy: { detail: "standard", nextStep: "direct", suppression: "none", version: 0 }, title: "One" };
    const state = { deliveries: [], interactionReceipts: [], nextPolicyVersion: 1, resetReceipts: [], schemaVersion: 10, threads: [thread], undoResetReceipts: [] };
    await writeFile(file, JSON.stringify(state));
    await expect(readAttunementState(file)).rejects.toThrow();
    await writeFile(file, JSON.stringify({ ...state, schemaVersion: 11 }));
    await expect(readAttunementState(file)).resolves.toMatchObject({ schemaVersion: 11 });
    const link2 = { ...link, threadId: "thread_2" };
    const thread2 = { ...thread, id: "thread_2", links: [link2], title: "Two" };
    await writeFile(file, JSON.stringify({ ...state, schemaVersion: 11, threads: [thread, thread2] }));
    await expect(readAttunementState(file)).rejects.toThrow(/Work artifact links/u);
  });
});
