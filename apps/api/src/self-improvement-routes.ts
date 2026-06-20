import { readWeaknesses, type WeaknessEntry } from "@muse/mcp";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

export interface WeaknessView {
  readonly axis: string;
  readonly topic: string;
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly hint: string | null;
  readonly pKnown: number | null;
}

export interface WeaknessesResponse {
  readonly total: number;
  readonly entries: readonly WeaknessView[];
}

/**
 * Shape the raw weakness ledger for the web "self-improvement" dashboard:
 * most-frequent first, ties broken by most-recent. Pure (deterministic) so the
 * ordering is unit-tested without a server. `hint`/`pKnown` normalize to null
 * (a JSON-friendly absent value) rather than being omitted.
 */
export function shapeWeaknesses(entries: readonly WeaknessEntry[]): WeaknessesResponse {
  const sorted = [...entries].sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
  return {
    total: entries.length,
    entries: sorted.map((e) => ({
      axis: e.axis,
      topic: e.topic,
      count: e.count,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
      hint: e.hint ?? null,
      pKnown: e.pKnown ?? null
    }))
  };
}

export interface SelfImprovementRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly weaknessesFile: string;
}

export function registerSelfImprovementRoutes(server: FastifyInstance, gate: SelfImprovementRoutesGate): void {
  const authed = (request: Parameters<typeof requireAuthenticated>[0], reply: Parameters<typeof requireAuthenticated>[1]) =>
    requireAuthenticated(request, reply, Boolean(gate.authService));

  // The Whetstone weakness ledger — what Muse has noticed it couldn't answer /
  // didn't do. Read-only; the CLI (`muse doctor --weaknesses`) is the writer.
  server.get("/api/self-improvement/weaknesses", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const entries = await readWeaknesses(gate.weaknessesFile);
    return shapeWeaknesses(entries);
  });
}
