import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type ActionLogEntry, appendActionLog, readActionLog } from "../src/personal-action-log-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "action-log-concurrency-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const entry = (i: number): ActionLogEntry => ({
  id: `a${i}`,
  result: "performed",
  userId: "u",
  what: `did thing ${i}`,
  when: "2026-01-01T00:00:00Z",
  why: "because",
});

describe("appendActionLog under concurrency — the audit trail must lose nothing", () => {
  it("records EVERY entry when many appends race (no crash, no last-writer-wins loss)", async () => {
    // Regression: read-modify-write + a `${pid}-${Date.now()}` tmp meant 25
    // concurrent appends crashed (ENOENT tmp-rename race) and dropped ~all
    // entries. A per-file append queue + random-uuid tmp makes it lossless —
    // critical because this is the accountability log (outbound-safety rule 4).
    const file = join(dir, "actions.json");
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_v, i) => appendActionLog(file, entry(i))));
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect((await readActionLog(file)).map((e) => e.id).sort()).toEqual(Array.from({ length: 25 }, (_v, i) => `a${i}`).sort());
  });

  it("preserves enqueue order through the serialized queue", async () => {
    const file = join(dir, "ordered.json");
    await Promise.all(Array.from({ length: 10 }, (_v, i) => appendActionLog(file, entry(i))));
    expect((await readActionLog(file)).map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_v, i) => `a${i}`));
  });

  it("still appends correctly when called sequentially", async () => {
    const file = join(dir, "seq.json");
    for (let i = 0; i < 5; i += 1) await appendActionLog(file, entry(i));
    expect((await readActionLog(file)).map((e) => e.id)).toEqual(["a0", "a1", "a2", "a3", "a4"]);
  });
});
