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

import { readQueryInteger, readQueryString, isRecord } from "./compat-parsers.js";
import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

const JOURNEY_KINDS: readonly JourneyStoreKind[] = ["fact", "skill", "strategy"];
const JOURNEY_KINDS_LIST = [...JOURNEY_KINDS];

function parseJourneyKind(value: string | undefined): JourneyStoreKind | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  const matched = JOURNEY_KINDS_LIST.find((kind) => kind === normalized);
  if (matched === undefined) {
    return undefined;
  }
  return matched;
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
    const kindRaw = readQueryString(request, "kind");
    const kind = parseJourneyKind(kindRaw);
    if (kindRaw !== undefined && kind === undefined) {
      return reply.status(400).send({ error: `kind must be one of: ${JOURNEY_KINDS.join(", ")}` });
    }
    const since = readQueryString(request, "since");
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
      const rawMuse = s.frontmatter.metadata?.["muse"];
      const muse = isRecord(rawMuse) ? rawMuse : {};
      const authoredAt = typeof muse.authoredAt === "string" ? muse.authoredAt : undefined;
      const lastUsedAt = typeof muse.lastUsedAt === "string" ? muse.lastUsedAt : undefined;
      return {
        description: s.description,
        name: s.name,
        ...(authoredAt ? { authoredAt } : {}),
        ...(lastUsedAt ? { lastUsedAt } : {})
      };
    });
    const limit = readQueryInteger(request, "limit", 50);
    const events = mergeJourneyEvents({
      facts,
      skills: skillRecords,
      strategies,
      ...(kind ? { kind } : {}),
      ...(since ? { since } : {}),
      ...(limit !== undefined ? { limit } : {})
    });
    return { events, total: events.length };
  });
}
