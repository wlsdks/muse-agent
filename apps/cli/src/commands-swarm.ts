/**
 * `muse swarm pending | promote <id> | reject <id>` — review and resolve the
 * know-how other Muses shared with you over A2A. Inbound know-how never runs or
 * auto-applies; it sits in quarantine (`muse swarm pending`) until you promote
 * it (into the authored-skill store, still execute-gated) or reject it. This is
 * the user-facing half of the personal swarm's "inbound is inert" guarantee.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { resolveAuthoredSkillsDir } from "@muse/autoconfigure";
import {
  listPending,
  readQuarantine,
  setQuarantineStatus,
  type SwarmQuarantineEntry
} from "@muse/mcp";
import { AuthoredSkillStore } from "@muse/skills";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

function quarantineFile(): string {
  return process.env.MUSE_SWARM_QUARANTINE_FILE?.trim() || join(homedir(), ".muse", "swarm-quarantine.json");
}

function whenMs(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function renderPending(entries: readonly SwarmQuarantineEntry[]): string {
  const pending = listPending(entries);
  if (pending.length === 0) {
    return "No quarantined know-how. Nothing other Muses shared is waiting for review.";
  }
  const lines = [`Quarantined know-how awaiting review (${pending.length.toString()}):\n`];
  for (const e of pending) {
    const preview = e.content.replace(/\s+/gu, " ").trim().slice(0, 80);
    lines.push(`  [${e.id.slice(0, 8)}] ${e.kind.padEnd(16)} from ${e.fromPeerId.padEnd(12)} ${whenMs(e.receivedAtMs)}`);
    lines.push(`     ${preview}${e.content.length > 80 ? "…" : ""}`);
  }
  lines.push("\nPromote one (becomes an execute-gated authored skill):  muse swarm promote <id>");
  lines.push("Reject one:                                            muse swarm reject <id>");
  return lines.join("\n");
}

/** Build the execute-gated authored-skill draft for a promoted swarm skill. */
export function buildSwarmSkillDraft(entry: SwarmQuarantineEntry): { readonly name: string; readonly description: string; readonly body: string } {
  return {
    body: entry.content,
    description: `Shared by ${entry.fromPeerId} via the Muse swarm (execute-gated — guidance only until you grant it tools).`,
    name: `swarm-${entry.fromPeerId}-${entry.id.slice(0, 8)}`.replace(/[^a-z0-9-]/giu, "-")
  };
}

function findPending(entries: readonly SwarmQuarantineEntry[], id: string): SwarmQuarantineEntry | undefined {
  return entries.find((e) => e.status === "pending" && (e.id === id || e.id.startsWith(id)));
}

export function registerSwarmCommands(program: Command, io: ProgramIO): void {
  const swarm = program
    .command("swarm")
    .description("Review know-how other Muses shared with you (A2A swarm — inbound is inert until you promote it)");

  swarm
    .command("pending")
    .description("List quarantined know-how awaiting your review")
    .option("--json", "Print the raw pending entries")
    .action(async (options: { readonly json?: boolean }) => {
      const entries = await readQuarantine(quarantineFile());
      if (options.json) {
        io.stdout(`${JSON.stringify(listPending(entries), null, 2)}\n`);
        return;
      }
      io.stdout(`${renderPending(entries)}\n`);
    });

  swarm
    .command("promote <id>")
    .description("Promote a quarantined skill into your authored skills (execute-gated guidance, not runnable)")
    .action(async (id: string) => {
      const file = quarantineFile();
      const entry = findPending(await readQuarantine(file), id);
      if (!entry) {
        io.stderr(`muse swarm promote: no pending quarantine entry matching '${id}' (see \`muse swarm pending\`).\n`);
        process.exitCode = 1;
        return;
      }
      if (entry.kind !== "skill") {
        io.stderr(`muse swarm promote: '${entry.kind}' promotion isn't supported yet — only 'skill'. Reject it or leave it pending.\n`);
        process.exitCode = 1;
        return;
      }
      const store = new AuthoredSkillStore({ dir: resolveAuthoredSkillsDir(process.env as Record<string, string | undefined>) });
      const result = await store.writeOrPatch(buildSwarmSkillDraft(entry));
      await setQuarantineStatus(file, entry.id, "promoted", Date.now());
      io.stdout(`✅ Promoted ${entry.id.slice(0, 8)} from ${entry.fromPeerId} → authored skill (${result.action}, execute-gated).\n`);
      if (result.reasons && result.reasons.length > 0) {
        io.stdout(`   ${result.reasons.join("; ")}\n`);
      }
    });

  swarm
    .command("reject <id>")
    .description("Reject quarantined know-how — discard it without applying")
    .action(async (id: string) => {
      const file = quarantineFile();
      const entry = findPending(await readQuarantine(file), id);
      if (!entry) {
        io.stderr(`muse swarm reject: no pending quarantine entry matching '${id}'.\n`);
        process.exitCode = 1;
        return;
      }
      await setQuarantineStatus(file, entry.id, "rejected", Date.now());
      io.stdout(`🗑  Rejected ${entry.id.slice(0, 8)} from ${entry.fromPeerId} — discarded.\n`);
    });
}
