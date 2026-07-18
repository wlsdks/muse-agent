import { describe, expect, it } from "vitest";

import { linkableFlows, linkableTasks } from "./work-logic.js";

import type { BoardResponse, FlowProjection, WorkRow } from "../api/types.js";

const WORK = {
  boardTaskIds: ["t1"],
  createdAtIso: "2026-07-18T00:00:00.000Z",
  flowIds: ["f1"],
  goal: "g",
  id: "w1",
  name: "W",
  outcomes: [],
  status: "active",
  threadId: null,
  updatedAtIso: "2026-07-18T00:00:00.000Z"
} as unknown as WorkRow;

const FLOWS = [
  { id: "f1", name: "Linked flow" },
  { id: "f2", name: "Free flow" }
] as unknown as FlowProjection[];

const TASKS = [
  { id: "t1", title: "Linked task" },
  { id: "t2", title: "Free task" }
] as unknown as BoardResponse["tasks"];

describe("linkable candidates — only the not-yet-linked", () => {
  it("excludes flows already linked to the Work", () => {
    expect(linkableFlows(FLOWS, WORK)).toEqual([{ id: "f2", label: "Free flow" }]);
  });

  it("excludes board tasks already linked to the Work", () => {
    expect(linkableTasks(TASKS, WORK)).toEqual([{ id: "t2", label: "Free task" }]);
  });

  it("empty stores yield empty option lists (picker hides itself)", () => {
    expect(linkableFlows([], WORK)).toEqual([]);
    expect(linkableTasks([], WORK)).toEqual([]);
  });
});
