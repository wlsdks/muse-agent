/**
 * Pure logic for the builder-grade Scheduled view: joining the two server
 * sources into one operational row per flow, summarizing WHAT each flow
 * does, and the one-shot "open in Builder" focus hint the Builder consumes.
 * No React, no fetch — the operational semantics stay unit-testable.
 */

import type { FlowProjection, SchedulerJobRow } from "../api/types.js";

export interface ScheduleRow {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** One-line action summary: an agent prompt's head, or `server.tool`. */
  readonly what: string;
  readonly cadence: SchedulerJobRow["cadenceSummary"] | null;
  readonly nextRunAtIso: string | null;
  readonly lastStatus: string | null;
  readonly lastRunAt: number | null;
}

const WHAT_MAX_LENGTH = 60;

function summarizeWhat(flow: FlowProjection): string {
  const action = flow.nodes.find((node) => node.kind === "action.agent" || node.kind === "action.tool");
  if (!action) {
    return "";
  }
  if (action.kind === "action.tool") {
    const server = typeof action.meta.server === "string" ? action.meta.server : "";
    const tool = typeof action.meta.tool === "string" ? action.meta.tool : "";
    return server && tool ? `${server}.${tool}` : server || tool;
  }
  const prompt = typeof action.meta.prompt === "string" ? action.meta.prompt : "";
  return prompt.length > WHAT_MAX_LENGTH ? `${prompt.slice(0, WHAT_MAX_LENGTH - 1).trimEnd()}…` : prompt;
}

/**
 * One operational row per flow, in the flows projection's order (enabled
 * first, soonest next-run first — the server already sorts). Job stats
 * (cadence/last run) join by id; a flow whose job row is missing (race
 * between the two fetches) still renders with the stats blank rather than
 * dropping the row.
 */
export function mergeScheduleRows(
  flows: readonly FlowProjection[],
  jobs: readonly SchedulerJobRow[]
): readonly ScheduleRow[] {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  return flows.map((flow) => {
    const job = jobById.get(flow.id);
    return {
      cadence: job?.cadenceSummary ?? null,
      enabled: flow.enabled,
      id: flow.id,
      lastRunAt: job?.lastRunAt ?? null,
      lastStatus: job?.lastStatus ?? null,
      name: flow.name,
      nextRunAtIso: flow.nextRunAtIso,
      what: summarizeWhat(flow)
    };
  });
}

/* ── one-shot Builder handoffs (focus / create-for-work) ───── */

const FOCUS_KEY = "muse.builderFocusFlow";

export function writeBuilderFocusHint(storage: Pick<Storage, "setItem"> | undefined, flowId: string): void {
  try {
    storage?.setItem(FOCUS_KEY, flowId);
  } catch {
    /* storage unavailable — the Builder just opens on its default flow */
  }
}

/** Reads AND clears the hint — a one-shot handoff, so a later manual visit
 * to the Builder never snaps back to a stale selection. */
const CREATE_FOR_WORK_KEY = "muse.builderCreateForWork";

/** Work → Builder: open the create panel and auto-link the created flow
 * back to this Work. One-shot, same discipline as the focus hint. */
export function writeBuilderCreateForWorkHint(storage: Pick<Storage, "setItem"> | undefined, workId: string): void {
  try {
    storage?.setItem(CREATE_FOR_WORK_KEY, workId);
  } catch {
    /* storage unavailable — the Builder just opens normally */
  }
}

export function consumeBuilderCreateForWorkHint(
  storage: (Pick<Storage, "getItem"> & Pick<Storage, "removeItem">) | undefined
): string | undefined {
  try {
    const value = storage?.getItem(CREATE_FOR_WORK_KEY);
    if (value) {
      storage?.removeItem(CREATE_FOR_WORK_KEY);
      return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function consumeBuilderFocusHint(
  storage: (Pick<Storage, "getItem"> & Pick<Storage, "removeItem">) | undefined
): string | undefined {
  try {
    const value = storage?.getItem(FOCUS_KEY);
    if (value) {
      storage?.removeItem(FOCUS_KEY);
      return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
