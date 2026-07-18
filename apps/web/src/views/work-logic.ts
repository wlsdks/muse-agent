/**
 * Pure candidate derivation for the Work view's link pickers — a Work links
 * to flows/board-tasks by PICKING them (builder grammar), never by typing a
 * raw id, so the pickers must offer exactly the not-yet-linked candidates.
 */

import type { BoardResponse, FlowProjection, WorkRow } from "../api/types.js";

export interface LinkOption {
  readonly id: string;
  readonly label: string;
}

/** Flows not already linked to this Work, as picker options. */
export function linkableFlows(flows: readonly FlowProjection[], work: WorkRow): readonly LinkOption[] {
  return flows
    .filter((flow) => !work.flowIds.includes(flow.id))
    .map((flow) => ({ id: flow.id, label: flow.name }));
}

/** Board tasks not already linked to this Work, as picker options. */
export function linkableTasks(tasks: BoardResponse["tasks"], work: WorkRow): readonly LinkOption[] {
  return tasks
    .filter((task) => !work.boardTaskIds.includes(task.id))
    .map((task) => ({ id: task.id, label: task.title }));
}
