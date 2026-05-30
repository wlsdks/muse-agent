/**
 * `muse swarm pending | promote <id> | reject <id>` — review and resolve the
 * know-how other Muses shared with you over A2A. Inbound know-how never runs or
 * auto-applies; it sits in quarantine (`muse swarm pending`) until you promote
 * it (into the authored-skill store, still execute-gated) or reject it. This is
 * the user-facing half of the personal swarm's "inbound is inert" guarantee.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isA2AEnabled, prepareOutbound } from "@muse/agent-core";
import { AGENT_CARD_PATH, buildMuseAgentCard, createA2AHandler, loadPeerConfig, sendToPeer } from "@muse/a2a";
import { resolveAuthoredSkillsDir } from "@muse/autoconfigure";
import {
  addToQuarantine,
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

function peersFile(): string {
  return process.env.MUSE_A2A_PEERS_FILE?.trim() || join(homedir(), ".muse", "a2a-peers.json");
}

/** The draft-first preview shown before a send is confirmed. Sends nothing. */
export function renderShareDraft(args: { readonly peerId: string; readonly skillName: string; readonly content: string; readonly redacted: boolean }): string {
  return [
    `Draft — would share this know-how with peer '${args.peerId}':`,
    `  skill: ${args.skillName}`,
    ...(args.redacted ? ["  (a secret was redacted before send)"] : []),
    "  ───",
    args.content.split("\n").map((l) => `  │ ${l}`).join("\n"),
    "  ───",
    "Nothing has been sent. Re-run with --yes to confirm the send."
  ].join("\n");
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
    .command("share <skill>")
    .description("Share an authored skill's know-how with a swarm peer (draft-first; --yes confirms the send)")
    .requiredOption("--to <peer>", "Peer id from ~/.muse/a2a-peers.json")
    .option("--yes", "Confirm and actually send (default: print the draft, send nothing)")
    .option("--file <path>", "Share an arbitrary skill markdown file instead of an authored skill by name")
    .action(async (skillName: string, options: { readonly to: string; readonly yes?: boolean; readonly file?: string }) => {
      const env = process.env;
      if (!isA2AEnabled(env)) {
        io.stderr("muse swarm share: the swarm is off — set MUSE_A2A_ENABLED=true to opt in.\n");
        process.exitCode = 1;
        return;
      }
      const config = await loadPeerConfig(peersFile());
      if (config.selfId.length === 0) {
        io.stderr(`muse swarm share: set "selfId" (who you are in the swarm) in ${peersFile()}.\n`);
        process.exitCode = 1;
        return;
      }
      const peer = config.peers.find((p) => p.id === options.to);
      if (!peer) {
        const known = config.peers.map((p) => p.id).join(", ") || "(none — add peers to ~/.muse/a2a-peers.json)";
        io.stderr(`muse swarm share: unknown peer '${options.to}'. Known peers: ${known}\n`);
        process.exitCode = 1;
        return;
      }
      let content: string | undefined;
      if (options.file) {
        content = await readFile(options.file, "utf8").catch(() => undefined);
        if (content === undefined) {
          io.stderr(`muse swarm share: cannot read --file '${options.file}'.\n`);
          process.exitCode = 1;
          return;
        }
      } else {
        const store = new AuthoredSkillStore({ dir: resolveAuthoredSkillsDir(env as Record<string, string | undefined>) });
        const skill = (await store.listAuthored()).find((s) => s.name === skillName);
        if (!skill) {
          io.stderr(`muse swarm share: no authored skill named '${skillName}' (see \`muse skills authored\`, or pass --file <path>).\n`);
          process.exitCode = 1;
          return;
        }
        content = skill.body;
      }
      // prepareOutbound is the gate: redacts PII; a non-know-how kind would throw (skill is fine).
      const envelope = prepareOutbound({ content, kind: "skill", label: skillName }, config.selfId);
      if (!options.yes) {
        io.stdout(`${renderShareDraft({ content: envelope.content, peerId: peer.id, redacted: envelope.redacted, skillName })}\n`);
        return;
      }
      const result = await sendToPeer({
        env,
        fetchImpl: io.fetch ?? globalThis.fetch,
        fromPeerId: config.selfId,
        outbound: { content, kind: "skill", label: skillName },
        peer
      });
      io.stdout(result.ok
        ? `✅ Shared '${skillName}' → ${peer.id} (HTTP ${result.status.toString()}).\n`
        : `⚠ Send to ${peer.id} returned HTTP ${result.status.toString()}.\n`);
    });

  swarm
    .command("serve")
    .description("Run an inbound A2A endpoint so peers can share know-how with you (Agent Card + message/send → quarantine). Off unless MUSE_A2A_ENABLED.")
    .option("--host <host>", "Bind host — 127.0.0.1 (default) for same-machine, your LAN IP for other devices", "127.0.0.1")
    .option("--port <port>", "Bind port (default 4111)", "4111")
    .action(async (options: { readonly host: string; readonly port: string }) => {
      const env = process.env;
      if (!isA2AEnabled(env)) {
        io.stderr("muse swarm serve: the swarm is off — set MUSE_A2A_ENABLED=true to opt in.\n");
        process.exitCode = 1;
        return;
      }
      const port = Number.parseInt(options.port, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        io.stderr(`muse swarm serve: invalid --port '${options.port}'.\n`);
        process.exitCode = 1;
        return;
      }
      const config = await loadPeerConfig(peersFile());
      const card = buildMuseAgentCard({ url: `http://${options.host}:${port.toString()}/a2a` });
      const handler = createA2AHandler({
        agentCard: card,
        deposit: (input) => addToQuarantine(quarantineFile(), input).then(() => undefined),
        env,
        registry: config.registry
      });
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void handler({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: req.headers as Record<string, string | undefined>,
            method: req.method ?? "GET",
            path: req.url ?? "/"
          }).then((r) => {
            res.writeHead(r.status, { "content-type": r.contentType });
            res.end(r.body);
          });
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(port, options.host, () => {
          io.stdout(
            `muse swarm: inbound A2A on http://${options.host}:${port.toString()}  (Agent Card: ${AGENT_CARD_PATH})\n` +
            `  allowlisted peers: ${config.peers.map((p) => p.id).join(", ") || "(none — add them to ~/.muse/a2a-peers.json)"}\n` +
            `  inbound is inert: know-how is quarantined for review, never executed. Ctrl-C to stop.\n`
          );
        });
        process.once("SIGINT", () => { server.close(); resolve(); });
      });
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
