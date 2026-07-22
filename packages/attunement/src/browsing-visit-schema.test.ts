import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPersonalThread, readAttunementState } from "./index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

async function storeFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "muse-attunement-browsing-schema-"));
  roots.push(root);
  return join(root, "attunement.json");
}

function state(schemaVersion: number, links: readonly unknown[] = []) {
  return {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion,
    threads: links.length === 0 ? [] : [{
      createdAt: "2026-07-22T00:00:00.000Z",
      id: "thread_1",
      kind: "life",
      links,
      policy: { detail: "standard", nextStep: "direct", suppression: "none", version: 0 },
      title: "Finish an article"
    }],
    undoResetReceipts: []
  };
}

describe("Attunement schema v9 browsing-visit references", () => {
  it("reads v8 byte-stably in memory and writes the current schema only on explicit mutation", async () => {
    const file = await storeFile();
    const raw = `${JSON.stringify(state(8), null, 2)}\n`;
    await writeFile(file, raw, "utf8");

    expect(await readAttunementState(file)).toMatchObject({ schemaVersion: 11 });
    expect(await readFile(file, "utf8")).toBe(raw);

    await createPersonalThread(file, { kind: "work", title: "Ship exact browsing context" });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ schemaVersion: 11 });
  });

  it("rejects browsing references in v1-v8 and accepts the same link and delivery evidence only in v9", async () => {
    const file = await storeFile();
    const reference = {
      artifactId: "13390000000000000-0a1b2c3d",
      artifactType: "browsing-visit",
      providerId: "local",
      role: "context"
    };
    for (let schemaVersion = 1; schemaVersion <= 8; schemaVersion += 1) {
      const raw = `${JSON.stringify(state(schemaVersion, [{
        ...reference,
        linkedAt: "2026-07-22T00:00:00.000Z",
        linkedBy: "user",
        threadId: "thread_1"
      }]), null, 2)}\n`;
      await writeFile(file, raw, "utf8");
      await expect(readAttunementState(file)).rejects.toThrow("attunement store is invalid");
      expect(await readFile(file, "utf8")).toBe(raw);
    }

    const current = state(9, [{
      ...reference,
      linkedAt: "2026-07-22T00:00:00.000Z",
      linkedBy: "user",
      threadId: "thread_1"
    }]);
    const withDelivery = {
      ...current,
      deliveries: [{
        evidenceClass: "organic",
        evidenceRefs: [reference],
        id: "delivery_1",
        openedAt: "2026-07-22T01:00:00.000Z",
        policyVersion: 0,
        threadId: "thread_1"
      }]
    };
    await writeFile(file, `${JSON.stringify(withDelivery, null, 2)}\n`, "utf8");
    await expect(readAttunementState(file)).resolves.toMatchObject({
      deliveries: [{ evidenceRefs: [reference] }],
      schemaVersion: 11,
      threads: [{ links: [expect.objectContaining(reference)] }]
    });
  });
});
