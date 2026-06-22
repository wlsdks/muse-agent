import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  patchProposedActionStatus,
  type ProposedAction,
  proposeMessageAction,
  readProposedActions,
  writeProposedActions,
} from "../src/personal-proposed-action-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "proposed-action-concurrency-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const seed = (i: number): ProposedAction => ({
  arguments: {},
  createdAt: "2026-01-01T00:00:00Z",
  destination: "C1",
  expiresAt: "2030-01-01T00:00:00Z",
  id: `x${i}`,
  kind: "message",
  providerId: "slack",
  reason: "r",
  status: "pending",
  summary: "s",
  text: "hi",
  userId: "u",
} as unknown as ProposedAction);

describe("proposed-action store under concurrency — draft-first proposals must not be lost", () => {
  it("applies EVERY status patch when many fire at once (no crash, no clobber)", async () => {
    // Regression: read-modify-write + `${pid}-${Date.now()}` tmp → concurrent
    // patches crashed (ENOENT) and clobbered each other (an approve/decline
    // silently lost). A per-file mutation queue + random-uuid tmp fixes both.
    const file = join(dir, "proposed.json");
    await writeProposedActions(file, Array.from({ length: 10 }, (_v, i) => seed(i)));
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_v, i) => patchProposedActionStatus(file, `x${i}`, "executed", "2026-01-02T00:00:00Z")),
    );
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    const executed = (await readProposedActions(file)).filter((p) => p.status === "executed").map((p) => p.id).sort();
    expect(executed).toEqual(["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"]);
  });

  it("persists every concurrently-proposed action", async () => {
    const file = join(dir, "propose.json");
    const input = (i: number) => ({ destination: "C1", providerId: "slack", reason: "r", summary: `s${i}`, text: `t${i}`, userId: "u" });
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_v, i) => proposeMessageAction(file, input(i))));
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(await readProposedActions(file)).toHaveLength(12);
  });

  it("works sequentially too (patch + read round-trip)", async () => {
    const file = join(dir, "seq.json");
    await writeProposedActions(file, [seed(0), seed(1)]);
    await patchProposedActionStatus(file, "x0", "declined", "2026-01-02T00:00:00Z");
    const byId = Object.fromEntries((await readProposedActions(file)).map((p) => [p.id, p.status]));
    expect(byId).toEqual({ x0: "declined", x1: "pending" });
  });
});
