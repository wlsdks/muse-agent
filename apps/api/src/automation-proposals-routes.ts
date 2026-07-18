/**
 * `GET /api/automation/proposals` — Builder automation proposals mined from
 * observed patterns ("3주 연속 월요일 오전에 X를 하셨네요 — 흐름으로
 * 만들까요?"). Draft-first: this route never creates a flow, it only
 * returns receipt-bearing candidates the web prefills the Builder create
 * panel with — the user still clicks 만들기.
 *
 * `POST /api/automation/proposals/:id/reject` ("사양할게요") records the id
 * into the rejected-proposals store so the SAME pattern never resurfaces.
 * There is deliberately NO accept endpoint — accepting happens client-side
 * via the Builder copilot seed, never a server-side flow creation.
 *
 * Detection mirrors the AUDIT shape `muse.pattern`'s `list` tool uses
 * (`loopback-patterns.ts`) — both detectors run directly with NO
 * `currentSlotOnly` restriction and no cooldown filter, because a proposal
 * is a review surface ("what routines have you noticed?"), not a "fire
 * right now" decision like `selectFireablePatterns`/the pattern-firing
 * daemon. The evidence gate inside `proposeFlowsFromPatterns` (confidence +
 * observation count) is the real filter for what gets proposed.
 */

import {
  aggregateActivitySignals,
  detectTimeOfDayPatterns,
  detectWeeklyTaskPatterns,
  type PatternMatch
} from "@muse/memory";
import { proposeFlowsFromPatterns, type FlowProposal } from "@muse/proactivity";
import { readRejectedProposals, recordRejectedProposal, rejectedProposalIds } from "@muse/stores";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

export interface AutomationProposalsGate {
  readonly authService: ServerOptions["authService"];
  readonly rejectedProposalsFile: string;
  readonly notesDir?: string;
  readonly tasksFile?: string;
  readonly now?: () => Date;
  /**
   * Test seam / full override of the detection path. Defaults to the
   * `aggregateActivitySignals` + raw-detector call documented above.
   */
  readonly detectPatterns?: (now: Date) => Promise<readonly PatternMatch[]>;
}

export interface AutomationProposalsResponse {
  readonly proposals: readonly FlowProposal[];
}

function defaultDetectPatterns(gate: AutomationProposalsGate): (now: Date) => Promise<readonly PatternMatch[]> {
  return async (now) => {
    const signals = await aggregateActivitySignals({
      now: () => now.getTime(),
      ...(gate.notesDir ? { notesDir: gate.notesDir } : {}),
      ...(gate.tasksFile ? { tasksFile: gate.tasksFile } : {})
    });
    return [...detectTimeOfDayPatterns(now, signals), ...detectWeeklyTaskPatterns(now, signals)];
  };
}

export function registerAutomationProposalsRoutes(server: FastifyInstance, gate: AutomationProposalsGate): void {
  const now = gate.now ?? (() => new Date());
  const detect = gate.detectPatterns ?? defaultDetectPatterns(gate);

  server.get("/api/automation/proposals", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }

    let matches: readonly PatternMatch[];
    try {
      matches = await detect(now());
    } catch {
      // A broken signal source (corrupt notes dir, unreadable tasks file)
      // must not 500 a review-only endpoint — degrade to "no proposals yet".
      matches = [];
    }
    const rejected = await readRejectedProposals(gate.rejectedProposalsFile).catch(() => []);
    const proposals = proposeFlowsFromPatterns(matches, rejectedProposalIds(rejected));
    const response: AutomationProposalsResponse = { proposals };
    return response;
  });

  server.post("/api/automation/proposals/:id/reject", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }

    const params = request.params as { id?: unknown };
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (id.length === 0) {
      return reply.status(400).send({ error: "id param must be a non-empty string" });
    }

    await recordRejectedProposal(gate.rejectedProposalsFile, id, now().toISOString());
    return { ok: true };
  });
}
