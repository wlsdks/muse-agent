import { homedir } from "node:os";
import { join } from "node:path";

import { resolveAuthoredSkillsDir } from "@muse/autoconfigure";
import { AuthoredSkillStore } from "@muse/skills";
import {
  buildSwarmSkillDraft,
  listPending,
  readQuarantine,
  setQuarantineStatus,
  type SwarmQuarantineEntry
} from "@muse/stores";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";
import { readRouteParam } from "./compat-parsers.js";

/**
 * `/api/swarm` — the web half of the swarm's "inbound is inert"
 * guarantee (the CLI half is `muse swarm pending|promote|reject`).
 * Know-how another Muse shared sits quarantined until the USER
 * resolves it here or in the terminal; promotion produces the same
 * execute-gated authored-skill draft as the CLI (shared builder), and
 * nothing ever auto-applies.
 */

export interface SwarmRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly quarantineFile?: string;
  readonly authoredSkillsDir?: string;
}

function defaultQuarantineFile(): string {
  return process.env.MUSE_SWARM_QUARANTINE_FILE?.trim() || join(homedir(), ".muse", "swarm-quarantine.json");
}

const findPending = (entries: readonly SwarmQuarantineEntry[], id: string): SwarmQuarantineEntry | undefined =>
  entries.find((e) => e.status === "pending" && (e.id === id || e.id.startsWith(id)));

export function registerSwarmRoutes(server: FastifyInstance, gate: SwarmRoutesGate): void {
  const authed = (request: Parameters<typeof requireAuthenticated>[0], reply: Parameters<typeof requireAuthenticated>[1]) =>
    requireAuthenticated(request, reply, Boolean(gate.authService));
  const file = () => gate.quarantineFile ?? defaultQuarantineFile();

  server.get("/api/swarm/pending", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const entries = listPending(await readQuarantine(file()));
    return {
      entries: entries.map((e) => ({
        content: e.content,
        fromPeerId: e.fromPeerId,
        id: e.id,
        kind: e.kind,
        receivedAtIso: new Date(e.receivedAtMs).toISOString(),
        ...(e.label !== undefined ? { label: e.label } : {})
      })),
      total: entries.length
    };
  });

  server.post("/api/swarm/:id/promote", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const id = readRouteParam(request, "id");

    if (!id) {
      return reply.status(400).send({ reason: "Invalid swarm id" });
    }
    const entry = findPending(await readQuarantine(file()), id);
    if (!entry) {
      return reply.status(404).send({ reason: `no pending entry "${id}"` });
    }
    if (entry.kind !== "skill") {
      return reply.status(409).send({ reason: `'${entry.kind}' promotion isn't supported — only 'skill'` });
    }
    const store = new AuthoredSkillStore({
      dir: gate.authoredSkillsDir ?? resolveAuthoredSkillsDir(process.env)
    });
    const result = await store.writeOrPatch(buildSwarmSkillDraft(entry));
    await setQuarantineStatus(file(), entry.id, "promoted", Date.now());
    return { action: result.action, id: entry.id, promoted: true };
  });

  server.post("/api/swarm/:id/reject", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const id = readRouteParam(request, "id");

    if (!id) {
      return reply.status(400).send({ reason: "Invalid swarm id" });
    }
    const entry = findPending(await readQuarantine(file()), id);
    if (!entry) {
      return reply.status(404).send({ reason: `no pending entry "${id}"` });
    }
    await setQuarantineStatus(file(), entry.id, "rejected", Date.now());
    return { id: entry.id, rejected: true };
  });
}
