import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addToQuarantine, listPending, readQuarantine, setQuarantineStatus } from "../src/swarm-quarantine-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-quarantine-"));
  file = join(dir, "quarantine.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("swarm-quarantine-store", () => {
  it("deposits a received payload as PENDING and round-trips it (label optional)", async () => {
    const entry = await addToQuarantine(file, { content: "a skill", fromPeerId: "peer-a", id: "q1", kind: "skill", label: "lbl", receivedAtMs: 100 });
    expect(entry).toMatchObject({ id: "q1", kind: "skill", label: "lbl", status: "pending" });
    expect(await readQuarantine(file)).toEqual([entry]);
    const noLabel = await addToQuarantine(file, { content: "s", fromPeerId: "peer-a", id: "q2", kind: "strategy", receivedAtMs: 200 });
    expect(noLabel).not.toHaveProperty("label");
  });

  it("returns [] for a missing or malformed file", async () => {
    expect(await readQuarantine(join(dir, "nope.json"))).toEqual([]);
    await writeFile(file, "{ not json", "utf8");
    expect(await readQuarantine(file)).toEqual([]);
  });

  it("FILTERS a tampered entry whose kind isn't shareable know-how on read (defense in depth)", async () => {
    // A corrupted/tampered store must not be able to smuggle an executable
    // 'tool-call' kind into quarantine — the store double-validates the safety
    // core's allowlist on every read.
    await writeFile(file, JSON.stringify({
      quarantine: [
        { content: "ok", fromPeerId: "p", id: "good", kind: "skill", receivedAtMs: 1, status: "pending" },
        { content: "evil", fromPeerId: "p", id: "bad", kind: "tool-call", receivedAtMs: 2, status: "pending" }
      ]
    }), "utf8");
    expect((await readQuarantine(file)).map((e) => e.id)).toEqual(["good"]);
  });

  it("listPending returns only pending entries, most-recent first", async () => {
    await addToQuarantine(file, { content: "a", fromPeerId: "p", id: "old", kind: "skill", receivedAtMs: 100 });
    await addToQuarantine(file, { content: "b", fromPeerId: "p", id: "new", kind: "skill", receivedAtMs: 300 });
    await addToQuarantine(file, { content: "c", fromPeerId: "p", id: "mid", kind: "skill", receivedAtMs: 200 });
    await setQuarantineStatus(file, "mid", "rejected", 400); // no longer pending
    expect(listPending(await readQuarantine(file)).map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("promotes / rejects a pending entry exactly once, stamping resolvedAtMs", async () => {
    await addToQuarantine(file, { content: "a", fromPeerId: "p", id: "q1", kind: "skill", receivedAtMs: 100 });
    const promoted = await setQuarantineStatus(file, "q1", "promoted", 500);
    expect(promoted).toMatchObject({ id: "q1", resolvedAtMs: 500, status: "promoted" });
    // already resolved → can't be re-resolved (no double-promote)
    expect(await setQuarantineStatus(file, "q1", "rejected", 600)).toBeNull();
    // unknown id → null
    expect(await setQuarantineStatus(file, "nope", "promoted", 700)).toBeNull();
    // the stored status reflects the single resolution
    expect((await readQuarantine(file)).find((e) => e.id === "q1")?.status).toBe("promoted");
  });
});
