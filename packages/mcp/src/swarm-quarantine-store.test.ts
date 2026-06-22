import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addToQuarantine,
  listPending,
  readQuarantine,
  setQuarantineStatus
} from "@muse/stores";

describe("swarm-quarantine-store — inbound know-how lands inert until promoted", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-quar-"));
    file = join(dir, "swarm-quarantine.json");
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("deposits a received skill as pending (never auto-applied)", async () => {
    const e = await addToQuarantine(file, { content: "set MTU 1380", fromPeerId: "phone", id: "q1", kind: "skill", receivedAtMs: 1_000 });
    expect(e.status).toBe("pending");
    const read = await readQuarantine(file);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ fromPeerId: "phone", id: "q1", kind: "skill", status: "pending" });
  });

  it("listPending returns only pending, most recent first", async () => {
    await addToQuarantine(file, { content: "a", fromPeerId: "phone", id: "q1", kind: "skill", receivedAtMs: 1_000 });
    await addToQuarantine(file, { content: "b", fromPeerId: "laptop", id: "q2", kind: "strategy", receivedAtMs: 3_000 });
    await addToQuarantine(file, { content: "c", fromPeerId: "phone", id: "q3", kind: "skill", receivedAtMs: 2_000 });
    await setQuarantineStatus(file, "q1", "rejected", 5_000);
    const pending = listPending(await readQuarantine(file));
    expect(pending.map((e) => e.id)).toEqual(["q2", "q3"]); // q1 resolved out; sorted by receivedAtMs desc
  });

  it("promote / reject resolve a pending entry once; a second resolve is a no-op", async () => {
    await addToQuarantine(file, { content: "x", fromPeerId: "phone", id: "q1", kind: "skill", receivedAtMs: 1_000 });
    const promoted = await setQuarantineStatus(file, "q1", "promoted", 2_000);
    expect(promoted).toMatchObject({ resolvedAtMs: 2_000, status: "promoted" });
    expect(listPending(await readQuarantine(file))).toHaveLength(0);
    // already resolved → null (can't double-promote / flip)
    expect(await setQuarantineStatus(file, "q1", "rejected", 3_000)).toBeNull();
    expect(await setQuarantineStatus(file, "nope", "promoted", 3_000)).toBeNull();
  });

  it("tolerant reads: missing / corrupt / wrong-shape / corrupt-row → drop only the bad", async () => {
    expect(await readQuarantine(file)).toEqual([]);
    await writeFile(file, "{ not json", "utf8");
    expect(await readQuarantine(file)).toEqual([]);
    await writeFile(file, JSON.stringify({ quarantine: [
      { content: "ok", fromPeerId: "p", id: "good", kind: "skill", receivedAtMs: 1, status: "pending" },
      { id: "bad", kind: "tool-call", content: "x", fromPeerId: "p", receivedAtMs: 1, status: "pending" }, // non-shareable kind dropped
      42
    ] }), "utf8");
    const read = await readQuarantine(file);
    expect(read).toHaveLength(1);
    expect(read[0]!.id).toBe("good");
  });

  it("preserves EVERY entry written concurrently (no lost receive)", async () => {
    await Promise.all(Array.from({ length: 15 }, (_u, i) =>
      addToQuarantine(file, { content: `c${i.toString()}`, fromPeerId: "p", id: `q${i.toString()}`, kind: "skill", receivedAtMs: 1_000 + i })));
    expect(await readQuarantine(file)).toHaveLength(15);
  });
});
