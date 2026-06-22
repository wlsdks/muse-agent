import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addObjective, readObjectives, type StandingObjective } from "@muse/stores";
import { type ObjectiveEvaluation } from "@muse/proactivity";
import { describe, expect, it } from "vitest";

import { startObjectivesTick } from "../src/objectives-tick.js";

function objectivesFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-obj-tick-")), "objectives.json");
}

function objective(overrides: Partial<StandingObjective> = {}): StandingObjective {
  return {
    createdAt: "2026-05-19T08:00:00.000Z",
    id: "obj_watch",
    kind: "until",
    spec: "watch the deploy until green",
    status: "active",
    userId: "stark",
    ...overrides
  };
}

const met = async (): Promise<ObjectiveEvaluation> => ({ outcome: "met" });

describe("startObjectivesTick — P9-b1 the objectives daemon rider drives runDueObjectives", () => {
  it("a tick fires runDueObjectives on a due objective: acted + durably marked done", async () => {
    const file = objectivesFile();
    await addObjective(file, objective());
    const acted: string[] = [];
    const handle = startObjectivesTick({
      act: async (o) => {
        acted.push(o.id);
      },
      evaluate: met,
      objectivesFile: file,
      now: () => new Date("2026-05-19T12:00:00.000Z")
    });
    try {
      await handle.tickOnce();
    } finally {
      handle.stop();
    }
    expect(acted).toEqual(["obj_watch"]);
    expect((await readObjectives(file))[0]?.status).toBe("done");
  });

  it("is single-flight: a concurrent tick does not double-fire while one is in-flight", async () => {
    const file = objectivesFile();
    await addObjective(file, objective());
    let evaluations = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = startObjectivesTick({
      act: async () => {},
      evaluate: async (): Promise<ObjectiveEvaluation> => {
        evaluations += 1;
        await gate;
        return { outcome: "unmet" };
      },
      objectivesFile: file,
      now: () => new Date("2026-05-19T12:00:00.000Z")
    });
    try {
      const inflight = handle.tickOnce();
      await handle.tickOnce(); // returns immediately — firing guard
      release?.();
      await inflight;
    } finally {
      handle.stop();
    }
    expect(evaluations).toBe(1);
  });

  it("fail-soft: a throwing evaluator does not crash the rider; a later tick still works", async () => {
    const file = objectivesFile();
    await addObjective(file, objective());
    const errors: string[] = [];
    let throwOnce = true;
    const acted: string[] = [];
    const handle = startObjectivesTick({
      act: async (o) => {
        acted.push(o.id);
      },
      errorLogger: (m) => errors.push(m),
      evaluate: async (): Promise<ObjectiveEvaluation> => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("condition source down");
        }
        return { outcome: "met" };
      },
      objectivesFile: file,
      now: () => new Date("2026-05-19T12:00:00.000Z")
    });
    try {
      await handle.tickOnce(); // throws internally → fail-soft
      expect(errors.some((e) => e.includes("condition source down"))).toBe(true);
      expect((await readObjectives(file))[0]?.status).toBe("active");
      await handle.tickOnce(); // rider survived → now succeeds
    } finally {
      handle.stop();
    }
    expect(acted).toEqual(["obj_watch"]);
    expect((await readObjectives(file))[0]?.status).toBe("done");
  });

  it("clamps a wild interval and still yields a working, stoppable rider", async () => {
    const file = objectivesFile();
    await addObjective(file, objective());
    const handle = startObjectivesTick({
      act: async () => {},
      evaluate: met,
      intervalMs: Number.POSITIVE_INFINITY,
      objectivesFile: file,
      now: () => new Date("2026-05-19T12:00:00.000Z")
    });
    try {
      await handle.tickOnce();
    } finally {
      handle.stop();
    }
    expect((await readObjectives(file))[0]?.status).toBe("done");
  });
});
