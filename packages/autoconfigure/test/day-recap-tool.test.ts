import { describe, expect, it } from "vitest";

import { composeDayRecap, createDayRecapTool, type DayRecapInput } from "../src/day-recap-tool.js";

const at = (h: number, m = 0): string => new Date(2026, 5, 14, h, m).toISOString();

describe("composeDayRecap", () => {
  it("lists what was accomplished (by time) and what slipped (soonest-overdue first)", () => {
    const data: DayRecapInput = {
      completedTasks: [{ completedAt: at(15), title: "ship the report" }],
      firedReminders: [{ firedAt: at(9), text: "take meds" }],
      overdueTasks: [{ dueAt: at(11), title: "call the bank" }],
      overdueReminders: [{ dueAt: at(8), text: "water the plants" }]
    };
    const recap = composeDayRecap(data);
    // accomplished by time: meds (9) < report (15)
    expect(recap.accomplished).toEqual(["09:00 ⏰ take meds", "✓ ship the report"]);
    // slipping soonest-overdue first: plants (8) < bank (11)
    expect(recap.slipping).toEqual(["⏰ water the plants (still overdue)", "☑ call the bank (still overdue)"]);
  });

  it("drops unparseable times instead of throwing", () => {
    expect(composeDayRecap({
      completedTasks: [{ completedAt: "nope", title: "x" }],
      firedReminders: [],
      overdueTasks: [],
      overdueReminders: []
    })).toEqual({ accomplished: [], slipping: [] });
  });
});

describe("createDayRecapTool", () => {
  it("is a read-risk tool named day_recap and returns the composed recap", async () => {
    const tool = createDayRecapTool({
      recapInput: () => ({
        completedTasks: [{ completedAt: at(10), title: "did a thing" }],
        firedReminders: [],
        overdueTasks: [],
        overdueReminders: []
      })
    });
    expect(tool.definition.name).toBe("day_recap");
    expect(tool.definition.risk).toBe("read");
    const result = (await tool.execute({}, { runId: "t", userId: "u" })) as { accomplished: string[]; slipping: string[] };
    expect(result.accomplished).toEqual(["✓ did a thing"]);
    expect(result.slipping).toEqual([]);
  });
});
