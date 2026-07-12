import { describe, expect, it } from "vitest";

import { selectDrainedProactiveTurns } from "./proactive-consume.js";

describe("selectDrainedProactiveTurns", () => {
  it("drains nothing when busy at consume time — a completion is never inserted mid-generation", () => {
    const result = selectDrainedProactiveTurns({
      grouped: "grouped notice",
      idleAtConsume: false,
      unseenJobs: [{ id: "job:1", text: "job done" }],
      unseenNudges: [{ id: "nudge:1", text: "nudge" }]
    });
    expect(result).toEqual([]);
  });

  it("drains grouped, then jobs, then nudges (in order) when idle", () => {
    const result = selectDrainedProactiveTurns({
      grouped: "grouped notice",
      idleAtConsume: true,
      unseenJobs: [{ id: "job:1", text: "job done" }],
      unseenNudges: [{ id: "nudge:1", text: "nudge text" }]
    });
    expect(result).toEqual([
      { role: "proactive", text: "grouped notice" },
      { role: "proactive", text: "job done" },
      { role: "proactive", text: "nudge text" }
    ]);
  });

  it("returns [] when idle but nothing is unseen", () => {
    const result = selectDrainedProactiveTurns({
      grouped: undefined,
      idleAtConsume: true,
      unseenJobs: [],
      unseenNudges: []
    });
    expect(result).toEqual([]);
  });

  it("drains only the job turns when there is no grouped notice or nudges", () => {
    const result = selectDrainedProactiveTurns({
      grouped: undefined,
      idleAtConsume: true,
      unseenJobs: [
        { id: "job:1", text: "job one done" },
        { id: "job:2", text: "job two done" }
      ],
      unseenNudges: []
    });
    expect(result).toEqual([
      { role: "proactive", text: "job one done" },
      { role: "proactive", text: "job two done" }
    ]);
  });

  it("does not mutate its input arrays", () => {
    const unseenJobs = [{ id: "job:1", text: "job done" }];
    const unseenNudges = [{ id: "nudge:1", text: "nudge" }];
    selectDrainedProactiveTurns({ grouped: undefined, idleAtConsume: true, unseenJobs, unseenNudges });
    expect(unseenJobs).toEqual([{ id: "job:1", text: "job done" }]);
    expect(unseenNudges).toEqual([{ id: "nudge:1", text: "nudge" }]);
  });
});
