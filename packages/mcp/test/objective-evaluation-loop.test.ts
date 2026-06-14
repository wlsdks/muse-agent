import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDueObjectives, type ObjectiveEvaluation, type RunDueObjectivesOptions } from "../src/objective-evaluation-loop.js";
import { addObjective, readObjectives, type StandingObjective } from "../src/personal-objectives-store.js";

let dir: string;
let file: string;
const NOW = new Date("2026-05-31T12:00:00.000Z");
const nowMs = NOW.getTime();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-objectives-"));
  file = join(dir, "objectives.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const obj = (over: Partial<StandingObjective> = {}): StandingObjective => ({
  createdAt: "2026-05-01T00:00:00Z",
  id: "o1",
  kind: "watch",
  spec: "watch the build",
  status: "active",
  userId: "u1",
  ...over
});

const run = (over: Partial<RunDueObjectivesOptions> = {}) => runDueObjectives({
  act: async () => undefined,
  evaluate: async (): Promise<ObjectiveEvaluation> => ({ outcome: "unmet" }),
  file,
  now: () => NOW,
  ...over
});
const byId = async (id: string) => (await readObjectives(file)).find((o) => o.id === id);

describe("runDueObjectives — standing-objective re-evaluation engine", () => {
  it("MET: fires the action exactly once and flips the objective to done (durable)", async () => {
    await addObjective(file, obj());
    let acted = 0;
    const summary = await run({ act: async () => { acted += 1; }, evaluate: async () => ({ outcome: "met" }) });
    expect(summary.fired).toEqual(["o1"]);
    expect(acted).toBe(1);
    expect(await byId("o1")).toMatchObject({ resolution: "condition met", status: "done" });
  });

  it("UNMEETABLE: escalates with the reason and flips to escalated (never silently dropped)", async () => {
    await addObjective(file, obj());
    const escalated: Array<{ id: string; reason: string }> = [];
    const summary = await run({
      escalate: async (o, reason) => { escalated.push({ id: o.id, reason }); },
      evaluate: async () => ({ outcome: "unmeetable", reason: "the repo was deleted" })
    });
    expect(summary.escalated).toEqual(["o1"]);
    expect(escalated).toEqual([{ id: "o1", reason: "the repo was deleted" }]);
    expect(await byId("o1")).toMatchObject({ resolution: "the repo was deleted", status: "escalated" });
  });

  it("an unparseable nextEvalAt does NOT freeze the objective — it is due now and self-heals", async () => {
    await addObjective(file, obj({ nextEvalAt: "not-a-date" })); // poisoned timestamp (hand-edit / foreign writer)
    let evaluated = 0;
    const summary = await run({ backoffBaseMs: 1000, evaluate: async () => { evaluated += 1; return { outcome: "unmet" }; } });
    expect(evaluated).toBe(1); // the poisoned objective was evaluated, not silently frozen forever
    expect(summary.retried).toEqual(["o1"]);
    const after = await byId("o1");
    // the loop rewrote a VALID, parseable nextEvalAt — the poison self-healed
    expect(Number.isFinite(Date.parse(after!.nextEvalAt!))).toBe(true);
    expect(Date.parse(after!.nextEvalAt!)).toBe(nowMs + 1000);
  });

  it("a non-finite backoffBaseMs (NaN from a typo'd knob) falls back to the default backoff, not a RangeError spin", async () => {
    await addObjective(file, obj());
    const summary = await run({ backoffBaseMs: Number.NaN, evaluate: async () => ({ outcome: "unmet" }) });
    expect(summary.retried).toEqual(["o1"]); // backed off (retried), NOT swallowed into errors
    expect(summary.errors).toEqual([]);
    const after = await byId("o1");
    expect(after?.status).toBe("active");
    // a VALID, parseable nextEvalAt (= nowMs + DEFAULT_BACKOFF_BASE_MS, attempts 1 → base * 2^0).
    // Old code: NaN delay → new Date(nowMs+NaN).toISOString() throws → caught → nextEvalAt unchanged → spins.
    expect(Number.isFinite(Date.parse(after!.nextEvalAt!))).toBe(true);
    expect(Date.parse(after!.nextEvalAt!)).toBe(nowMs + 60_000);
  });

  it("a non-finite backoffMaxMs (NaN cap) is also guarded — Math.min(NaN, x) would poison the delay", async () => {
    await addObjective(file, obj());
    const summary = await run({ backoffBaseMs: 1000, backoffMaxMs: Number.NaN, evaluate: async () => ({ outcome: "unmet" }) });
    expect(summary.retried).toEqual(["o1"]); // cap fell back to its default → delay = min(default, 1000) = 1000
    expect(summary.errors).toEqual([]);
    expect(Date.parse((await byId("o1"))!.nextEvalAt!)).toBe(nowMs + 1000);
  });

  it("UNMET: backs off with an exponential nextEvalAt and stays active (never spins)", async () => {
    await addObjective(file, obj());
    const summary = await run({ backoffBaseMs: 1000, evaluate: async () => ({ outcome: "unmet" }) });
    expect(summary.retried).toEqual(["o1"]);
    const after = await byId("o1");
    expect(after?.status).toBe("active");
    expect(after?.attempts).toBe(1);
    // first unmet → delay = base * 2^0 = 1000ms
    expect(Date.parse(after!.nextEvalAt!)).toBe(nowMs + 1000);
  });

  it("UNMET past maxAttempts: escalates instead of retrying forever", async () => {
    await addObjective(file, obj({ attempts: 2 })); // one more unmet → 3 attempts
    const summary = await run({ evaluate: async () => ({ outcome: "unmet" }), maxAttempts: 3 });
    expect(summary.escalated).toEqual(["o1"]);
    expect(await byId("o1")).toMatchObject({ status: "escalated" });
  });

  it("only picks DUE objectives: skips done/cancelled and a future nextEvalAt", async () => {
    await addObjective(file, obj({ id: "active-due" }));
    await addObjective(file, obj({ id: "done", status: "done" }));
    await addObjective(file, obj({ id: "future", nextEvalAt: new Date(nowMs + 60_000).toISOString() }));
    await addObjective(file, obj({ id: "past-due", nextEvalAt: new Date(nowMs - 60_000).toISOString() }));
    const summary = await run({ evaluate: async () => ({ outcome: "met" }), act: async () => undefined });
    expect(summary.fired.sort()).toEqual(["active-due", "past-due"]);
    expect(summary.due).toBe(2);
  });

  it("caps the objectives processed per tick (a backlog can't burst)", async () => {
    for (let i = 0; i < 5; i += 1) await addObjective(file, obj({ id: `o${i.toString()}` }));
    const summary = await run({ evaluate: async () => ({ outcome: "met" }), maxPerTick: 2 });
    expect(summary.due).toBe(2);
    expect(summary.fired).toHaveLength(2);
  });

  it("fail-open: an evaluator error is recorded, leaves the objective active, and doesn't crash siblings", async () => {
    await addObjective(file, obj({ id: "boom" }));
    await addObjective(file, obj({ id: "ok" }));
    const summary = await run({
      evaluate: async (o) => { if (o.id === "boom") throw new Error("evaluator crashed"); return { outcome: "met" }; }
    });
    expect(summary.errors.some((e) => e.includes("boom") && e.includes("evaluator crashed"))).toBe(true);
    expect(summary.fired).toContain("ok"); // sibling still processed
    expect(await byId("boom")).toMatchObject({ status: "active" }); // left for the next tick
  });

  it("does NOT fire/flip-to-done when act() throws on a MET condition — the objective stays active for a later tick", async () => {
    await addObjective(file, obj());
    const summary = await run({
      act: async () => { throw new Error("messenger down"); },
      evaluate: async () => ({ outcome: "met" })
    });
    expect(summary.fired).toEqual([]); // the action failed → not counted as fired
    expect(summary.errors.some((e) => e.includes("messenger down"))).toBe(true);
    // A met condition whose action FAILED must NOT be marked done, or the action never retries.
    expect(await byId("o1")).toMatchObject({ status: "active" });
  });
});
