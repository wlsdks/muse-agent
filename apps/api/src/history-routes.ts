/**
 * `GET /api/history` — unified activity feed for the web UI +
 * external clients. Mirrors the `muse history` CLI command and
 * the `muse.history.recent` MCP loopback tool. All three consume
 * the same `readActivityFeed` helper from `@muse/mcp/personal-
 * activity-feed.ts` so coverage stays identical across surfaces.
 *
 * Query params:
 *   - `kind` (optional) — `reminder | proactive | followup | pattern | episode`
 *   - `sinceIso` (optional) — drop entries older than this timestamp
 *   - `limit` (optional, default 20, cap 200)
 *
 * Auth: `requireAuthenticated` (same posture as `/api/today`).
 */

import { ACTIVITY_KINDS, readActivityFeed, type ActivityKind } from "@muse/domain-tools";
import type { FastifyInstance } from "fastify";

import { readQueryInteger, readQueryString } from "./compat-parsers.js";
import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

interface HistoryRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly reminderHistoryFile?: string;
  readonly proactiveHistoryFile?: string;
  readonly followupsFile?: string;
  readonly patternsFiredFile?: string;
  readonly episodesFile?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const ACTIVITY_KINDS_LIST = [...ACTIVITY_KINDS];

function parseActivityKind(value: string | undefined): ActivityKind | undefined {
  const candidate = value?.trim().toLowerCase();
  if (!candidate) {
    return undefined;
  }
  return ACTIVITY_KINDS_LIST.find((kind) => kind === candidate);
}

export function registerHistoryRoutes(server: FastifyInstance, gate: HistoryRoutesGate): void {
  server.get("/api/history", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const kindParam = readQueryString(request, "kind");
    const kind = parseActivityKind(kindParam);
    if (kindParam !== undefined && kind === undefined) {
      return reply.status(400).send({
        error: `kind must be one of: ${[...ACTIVITY_KINDS].join(", ")} (got '${kindParam}')`
      });
    }
    const sinceIso = readQueryString(request, "sinceIso");
    const sinceMs = sinceIso === undefined
      ? undefined
      : Date.parse(sinceIso);
    if (sinceMs !== undefined && !Number.isFinite(sinceMs)) {
      return reply.status(400).send({
        error: `sinceIso must be a parseable ISO timestamp (got '${sinceIso}')`
      });
    }

    // Strict-parse via the shared helper so a `?limit=20x` /
    // unit-slip `?limit=5min` falls back to the default instead of
    // silently becoming 20 / 5. Matches the CLI convention
    // and the `readQueryInteger` contract every other compat route
    // uses.
    const requested = readQueryInteger(request, "limit", DEFAULT_LIMIT);
    const limit = requested > 0 ? Math.min(MAX_LIMIT, requested) : DEFAULT_LIMIT;

    const entries = await readActivityFeed({
      episodesFile: gate.episodesFile,
      followupsFile: gate.followupsFile,
      ...(kind ? { kind } : {}),
      limit,
      patternsFiredFile: gate.patternsFiredFile,
      proactiveHistoryFile: gate.proactiveHistoryFile,
      reminderHistoryFile: gate.reminderHistoryFile,
      ...(sinceMs !== undefined ? { sinceMs } : {})
    });

    return { entries, total: entries.length };
  });
}
