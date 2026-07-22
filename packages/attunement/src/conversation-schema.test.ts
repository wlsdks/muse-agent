import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPersonalThread, readAttunementState } from "./index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

async function storeFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "muse-attunement-conversation-schema-"));
  roots.push(root);
  return join(root, "attunement.json");
}

function state(schemaVersion: number, links: readonly unknown[] = []) {
  return {
    deliveries: [], interactionReceipts: [], nextPolicyVersion: 1, resetReceipts: [], schemaVersion,
    threads: links.length === 0 ? [] : [{
      createdAt: "2026-07-22T00:00:00.000Z", id: "thread_1", kind: "work", links,
      policy: { detail: "standard", nextStep: "direct", suppression: "none", version: 0 }, title: "Ship"
    }],
    undoResetReceipts: []
  };
}

describe("Attunement schema v10 conversation references", () => {
  it("reads v9 byte-stably in memory and writes v10 only on mutation", async () => {
    const file = await storeFile();
    const raw = `${JSON.stringify(state(9), null, 2)}\n`;
    await writeFile(file, raw, "utf8");
    expect(await readAttunementState(file)).toMatchObject({ schemaVersion: 11 });
    expect(await readFile(file, "utf8")).toBe(raw);
    await createPersonalThread(file, { kind: "work", title: "Link exact conversation" });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ schemaVersion: 11 });
  });

  it("rejects conversation references in v1-v9 and accepts canonical context in v10", async () => {
    const file = await storeFile();
    const link = {
      artifactId: "conv_0a1b2c3d", artifactType: "conversation", linkedAt: "2026-07-22T00:00:00.000Z",
      linkedBy: "user", providerId: "local", role: "context", threadId: "thread_1"
    };
    for (let version = 1; version <= 9; version += 1) {
      await writeFile(file, `${JSON.stringify(state(version, [link]), null, 2)}\n`, "utf8");
      await expect(readAttunementState(file)).rejects.toThrow("attunement store is invalid");
    }
    await writeFile(file, `${JSON.stringify(state(10, [link]), null, 2)}\n`, "utf8");
    await expect(readAttunementState(file)).resolves.toMatchObject({ schemaVersion: 11, threads: [{ links: [link] }] });
  });
});
