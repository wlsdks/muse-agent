import { describe, expect, it } from "vitest";

import {
  consumeBuilderCopilotSeed,
  consumeBuilderFocusHint,
  mergeScheduleRows,
  writeBuilderCopilotSeed,
  writeBuilderFocusHint
} from "./scheduled-logic.js";

import type { FlowProjection, SchedulerJobRow } from "../api/types.js";

function flow(overrides: Partial<FlowProjection>): FlowProjection {
  return {
    edges: [],
    enabled: true,
    id: "job_1",
    name: "Morning brief",
    nextRunAtIso: "2026-07-19T00:00:00.000Z",
    nodes: [
      { id: "job_1::trigger", kind: "trigger.schedule", label: "trigger.schedule", meta: { cronExpression: "0 9 * * *" } },
      { id: "job_1::action", kind: "action.agent", label: "action.agent", meta: { prompt: "오늘 일정 요약해서 보내줘" } },
      { id: "job_1::output", kind: "output.record", label: "output.record", meta: {} }
    ],
    source: "scheduler",
    ...overrides
  };
}

function job(overrides: Partial<SchedulerJobRow>): SchedulerJobRow {
  return {
    agentPrompt: "오늘 일정 요약해서 보내줘",
    cadenceSummary: { hour: 9, kind: "daily", minute: 0 },
    createdAt: 1,
    cronExpression: "0 9 * * *",
    enabled: true,
    id: "job_1",
    lastRunAt: 1_752_800_000_000,
    lastStatus: "SUCCESS",
    name: "Morning brief",
    ...overrides
  };
}

describe("mergeScheduleRows", () => {
  it("joins job stats onto the flow row by id, keeping the flows' order", () => {
    const rows = mergeScheduleRows([flow({})], [job({})]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cadence: { hour: 9, kind: "daily", minute: 0 },
      enabled: true,
      id: "job_1",
      lastStatus: "SUCCESS",
      nextRunAtIso: "2026-07-19T00:00:00.000Z",
      what: "오늘 일정 요약해서 보내줘"
    });
  });

  it("summarizes a tool flow as server.tool", () => {
    const toolFlow = flow({
      nodes: [
        { id: "job_1::trigger", kind: "trigger.schedule", label: "trigger.schedule", meta: {} },
        { id: "job_1::action", kind: "action.tool", label: "action.tool", meta: { server: "muse.time", tool: "now" } },
        { id: "job_1::output", kind: "output.record", label: "output.record", meta: {} }
      ]
    });
    expect(mergeScheduleRows([toolFlow], [job({})])[0]!.what).toBe("muse.time.now");
  });

  it("truncates a long agent prompt with an ellipsis", () => {
    const long = "아".repeat(80);
    const rows = mergeScheduleRows(
      [flow({ nodes: [{ id: "n", kind: "action.agent", label: "action.agent", meta: { prompt: long } }] })],
      []
    );
    expect(rows[0]!.what.length).toBeLessThanOrEqual(60);
    expect(rows[0]!.what.endsWith("…")).toBe(true);
  });

  it("a flow with no matching job row still renders (stats blank), never dropped", () => {
    const rows = mergeScheduleRows([flow({ id: "job_x" })], [job({})]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cadence: null, id: "job_x", lastRunAt: null, lastStatus: null });
  });
});

describe("builder focus hint", () => {
  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      removeItem: (k: string) => void map.delete(k),
      setItem: (k: string, v: string) => void map.set(k, v)
    };
  }

  it("is a ONE-SHOT handoff: consumed once, gone after", () => {
    const store = memoryStorage();
    writeBuilderFocusHint(store, "job_42");
    expect(consumeBuilderFocusHint(store)).toBe("job_42");
    expect(consumeBuilderFocusHint(store)).toBeUndefined();
  });

  it("fail-safe on absent/throwing storage", () => {
    expect(consumeBuilderFocusHint(undefined)).toBeUndefined();
    expect(() => writeBuilderFocusHint(undefined, "x")).not.toThrow();
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); }
    };
    expect(consumeBuilderFocusHint(throwing)).toBeUndefined();
    expect(() => writeBuilderFocusHint(throwing, "x")).not.toThrow();
  });
});

describe("builder copilot seed (chat → Builder handoff)", () => {
  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      removeItem: (k: string) => void map.delete(k),
      setItem: (k: string, v: string) => void map.set(k, v)
    };
  }

  it("is a ONE-SHOT handoff: consumed once, gone after", () => {
    const store = memoryStorage();
    writeBuilderCopilotSeed(store, "매일 아침 9시에 오늘 일정 요약해주는 자동화 만들어줘");
    expect(consumeBuilderCopilotSeed(store)).toBe("매일 아침 9시에 오늘 일정 요약해주는 자동화 만들어줘");
    expect(consumeBuilderCopilotSeed(store)).toBeUndefined();
  });

  it("fail-safe on absent/throwing storage", () => {
    expect(consumeBuilderCopilotSeed(undefined)).toBeUndefined();
    expect(() => writeBuilderCopilotSeed(undefined, "x")).not.toThrow();
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); }
    };
    expect(consumeBuilderCopilotSeed(throwing)).toBeUndefined();
    expect(() => writeBuilderCopilotSeed(throwing, "x")).not.toThrow();
  });
});
