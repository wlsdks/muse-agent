/**
 * Read-only HTTP surface for `muse journey` — the merged "what Muse learned
 * about you" timeline (facts, authored skills, playbook strategies), for the
 * web console's Journey view. Shares the exact merge/expand logic the CLI
 * uses (`@muse/stores` journey-timeline) so the two surfaces never diverge —
 * this route builds the same per-store record arrays the CLI builds and
 * hands them to the same `mergeJourneyEvents`.
 *
 * Read-only by design: this is local self-knowledge, not an outbound action,
 * so no draft-first gate applies (outbound-safety.md governs sends toward a
 * third party, not reading your own stores).
 */

import { readBeliefProvenance } from "@muse/memory";
import { loadSkillsFromDirectory } from "@muse/skills";
import {
  factRecordsFromProvenance,
  mergeJourneyEvents,
  readPlaybook,
  type JourneySkillRecord,
  type JourneyStoreKind,
  type JourneyStrategyRecord
} from "@muse/stores";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

const JOURNEY_KINDS: readonly JourneyStoreKind[] = ["fact", "skill", "strategy"];

function isJourneyStoreKind(value: string): value is JourneyStoreKind {
  return (JOURNEY_KINDS as readonly string[]).includes(value);
}

function readString(request: { query?: unknown }, key: string): string {
  const query = (request.query as Record<string, unknown> | undefined) ?? {};
  const value = query[key];
  return typeof value === "string" ? value.trim() : "";
}

function readLimit(request: { query?: unknown }, fallback: number): number | undefined {
  const raw = readString(request, "limit");
  if (raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : fallback;
}

export interface JourneyRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly beliefProvenanceFile: string;
  readonly playbookFile: string;
  readonly authoredSkillsDir: string;
}

export function registerJourneyRoutes(server: FastifyInstance, gate: JourneyRoutesGate): void {
  const authed = (request: Parameters<typeof requireAuthenticated>[0], reply: Parameters<typeof requireAuthenticated>[1]) =>
    requireAuthenticated(request, reply, Boolean(gate.authService));

  server.get("/api/journey", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const kindRaw = readString(request, "kind");
    if (kindRaw && !isJourneyStoreKind(kindRaw)) {
      return reply.status(400).send({ error: `kind must be one of: ${JOURNEY_KINDS.join(", ")}` });
    }
    const since = readString(request, "since");
    if (since && !Number.isFinite(Date.parse(since))) {
      return reply.status(400).send({ error: "since must be a valid ISO date" });
    }
    const [provenance, playbookEntries, skills] = await Promise.all([
      readBeliefProvenance(gate.beliefProvenanceFile),
      readPlaybook(gate.playbookFile),
      loadSkillsFromDirectory(gate.authoredSkillsDir, "authored")
    ]);
    const facts = factRecordsFromProvenance(provenance);
    const strategies: readonly JourneyStrategyRecord[] = playbookEntries.map((e) => ({
      createdAt: e.createdAt,
      id: e.id,
      text: e.text,
      ...(e.lastReinforcedAt ? { lastReinforcedAt: e.lastReinforcedAt } : {})
    }));
    const skillRecords: readonly JourneySkillRecord[] = skills.map((s) => {
      const muse = (s.frontmatter.metadata?.["muse"] ?? {}) as Record<string, unknown>;
      const authoredAt = typeof muse.authoredAt === "string" ? muse.authoredAt : undefined;
      const lastUsedAt = typeof muse.lastUsedAt === "string" ? muse.lastUsedAt : undefined;
      return {
        description: s.description,
        name: s.name,
        ...(authoredAt ? { authoredAt } : {}),
        ...(lastUsedAt ? { lastUsedAt } : {})
      };
    });
    const limit = readLimit(request, 50);
    const events = mergeJourneyEvents({
      facts,
      skills: skillRecords,
      strategies,
      ...(kindRaw ? { kind: kindRaw as JourneyStoreKind } : {}),
      ...(since ? { since } : {}),
      ...(limit !== undefined ? { limit } : {})
    });
    return { events, total: events.length };
  });
}
