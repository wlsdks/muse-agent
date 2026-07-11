import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addObjective, readObjectives, type StandingObjective } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDueObjectives, type ObjectiveEvaluation } from "../src/objective-evaluation-loop.js";

let dir: string;
let file: string;
const NOW = new Date("2026-05-31T12:00:00.000Z");
const lockPath = (): string => `${file}.firing.lock`;

const EVIDENCE = [{ source: "test:store", text: "resolved evidence" }] as const;

const obj = (over: Partial<StandingObjective> = {}): StandingObjective => ({
  createdAt: "2026-05-01T00:00:00Z",
  id: "o1",
  kind: "watch",
  spec: "watch the build",
  status: "active",
  userId: "u1",
  ...over
});

async function lockFileExists(): Promise<boolean> {
  try {
    await stat(lockPath());
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-objectives-lock-"));
  file = join(dir, "objectives.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("runDueObjectives — cross-process firing lock (two daemons, same objectives file)", () => {
  it("TWO CONCURRENT daemons racing the same due objective: acted EXACTLY once total, one run reports lock-held", async () => {
    await addObjective(file, obj());
    let concurrentActs = 0;
    let maxConcurrentActs = 0;
    let totalActed = 0;
    const slowMetAct = async (): Promise<void> => {
      concurrentActs += 1;
      maxConcurrentActs = Math.max(maxConcurrentActs, concurrentActs);
      // Slow actuator — widens the race window a real double-fire bug needs.
      await new Promise((resolve) => setTimeout(resolve, 40));
      concurrentActs -= 1;
      totalActed += 1;
    };
    const evaluate = async (): Promise<ObjectiveEvaluation> => ({ evidence: EVIDENCE, outcome: "met" });
    const runTick = () => runDueObjectives({ act: slowMetAct, evaluate, file, now: () => NOW });

    const [a, b] = await Promise.all([runTick(), runTick()]);

    const outcomes = [a.outcome ?? "ran", b.outcome ?? "ran"].sort();
    expect(outcomes).toEqual(["lock-held", "ran"]);
    // Acted exactly once total across BOTH runs — the double-fire this fire closes.
    expect(totalActed).toBe(1);
    expect(maxConcurrentActs).toBe(1);
    const after = await readObjectives(file);
    expect(after.filter((entry) => entry.status === "done")).toHaveLength(1);
  });

  it("releases the lock after a successful tick — a later tick is not blocked", async () => {
    await addObjective(file, obj());
    const summary = await runDueObjectives({
      act: async () => undefined,
      evaluate: async () => ({ evidence: EVIDENCE, outcome: "met" }),
      file,
      now: () => NOW
    });
    expect(summary.fired).toEqual(["o1"]);
    expect(summary.outcome).toBeUndefined();
    expect(await lockFileExists()).toBe(false);
  });

  it("releases the lock after an act-failure tick — the next tick can retry rather than being permanently blocked", async () => {
    await addObjective(file, obj());
    const summary = await runDueObjectives({
      act: async () => { throw new Error("actuator down"); },
      evaluate: async () => ({ evidence: EVIDENCE, outcome: "met" }),
      file,
      now: () => NOW
    });
    expect(summary.fired).toEqual([]);
    expect(summary.errors).toHaveLength(1);
    expect(await lockFileExists()).toBe(false);

    const retry = await runDueObjectives({
      act: async () => undefined,
      evaluate: async () => ({ evidence: EVIDENCE, outcome: "met" }),
      file,
      now: () => NOW
    });
    expect(retry.fired).toEqual(["o1"]);
  });

  it("a STALE lock left behind by a crashed daemon does not permanently block evaluation — the tick proceeds", async () => {
    await addObjective(file, obj());
    await writeFile(lockPath(), "crashed-daemon-pid", "utf8");
    const oldMtime = new Date(2026, 6, 1);
    await utimes(lockPath(), oldMtime, oldMtime);

    const summary = await runDueObjectives({
      act: async () => undefined,
      evaluate: async () => ({ evidence: EVIDENCE, outcome: "met" }),
      file,
      now: () => NOW
    });
    expect(summary.fired).toEqual(["o1"]);
    expect(await lockFileExists()).toBe(false);
  });

  it("a LIVE lock (another daemon actively evaluating) short-circuits to lock-held with no evaluate/act attempted and no marks", async () => {
    await addObjective(file, obj());
    await writeFile(lockPath(), "other-daemon-pid", "utf8"); // fresh mtime — live

    let evaluated = 0;
    const summary = await runDueObjectives({
      act: async () => undefined,
      evaluate: async () => { evaluated += 1; return { evidence: EVIDENCE, outcome: "met" }; },
      file,
      now: () => NOW
    });
    expect(summary.outcome).toBe("lock-held");
    expect(summary.due).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(evaluated).toBe(0);
    const after = await readObjectives(file);
    expect(after.every((entry) => entry.status === "active")).toBe(true); // untouched
  });
});
