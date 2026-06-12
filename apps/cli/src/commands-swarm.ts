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

import { buildDebateQuestion, buildGroundingReverifyPrompt, hasCouncilConsensus, isA2AEnabled, parseGroundingReverifyJson, REVERIFY_RESPONSE_FORMAT, prepareOutbound, produceCouncilReasoning, produceGroundedCouncilReasoning, REVERIFY_SYSTEM_PROMPT, synthesizeCouncilAnswer, type CouncilAnswer, type CouncilUtterance, type GroundingReverify } from "@muse/agent-core";
import { AGENT_CARD_PATH, buildMuseAgentCard, createA2AHandler, loadPeerConfig, requestCouncilReasoning, sendToPeer, type A2APeer } from "@muse/a2a";
import { createMuseRuntimeAssembly, resolveAuthoredSkillsDir } from "@muse/autoconfigure";
import {
  addToQuarantine,
  listPending,
  readQuarantine,
  setQuarantineStatus,
  type SwarmQuarantineEntry
} from "@muse/mcp";
import { AuthoredSkillStore } from "@muse/skills";
import type { ModelProvider } from "@muse/model";
import type { Command } from "commander";

import { councilCorpusMatches, isCouncilGroundedMode } from "./council-corpus.js";
import type { ProgramIO } from "./program.js";

/**
 * Produce one council member's reasoning, honouring this node's grounded-council
 * posture: in grounded mode (`MUSE_A2A_COUNCIL_GROUNDED`) the member self-abstains
 * (returns "") when its OWN notes hold no confident evidence for the question, so
 * an ignorant voice never dilutes the synthesis. `reasoningQuestion` is what the
 * member reasons about (a debate round adds the others' digest); `retrievalQuestion`
 * is the ORIGINAL question the corpus relevance is judged against. Default (off) is
 * byte-identical to `produceCouncilReasoning`.
 */
async function councilMemberReasoning(args: {
  readonly reasoningQuestion: string;
  readonly retrievalQuestion: string;
  readonly model: string;
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly env: Record<string, string | undefined>;
}): Promise<string> {
  const { reasoningQuestion, retrievalQuestion, model, modelProvider, env } = args;
  if (!isCouncilGroundedMode(env)) {
    return produceCouncilReasoning(reasoningQuestion, { model, modelProvider });
  }
  const matches = await councilCorpusMatches(retrievalQuestion, { env });
  return produceGroundedCouncilReasoning(reasoningQuestion, matches, { model, modelProvider });
}

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

export interface SwarmStatus {
  readonly enabled: boolean;
  readonly councilEnabled: boolean;
  readonly councilGrounded: boolean;
  readonly selfId: string;
  readonly peers: readonly { readonly id: string; readonly url: string }[];
  readonly pendingCount: number;
}

export function renderSwarmStatus(s: SwarmStatus): string {
  const onOff = (v: boolean, hint: string): string => (v ? "ON" : `OFF (${hint})`);
  const lines = [
    "Muse swarm — status",
    `  A2A:     ${onOff(s.enabled, "set MUSE_A2A_ENABLED=true")}`,
    `  Council: ${onOff(s.councilEnabled, "set MUSE_A2A_COUNCIL=true")}`,
    `  Grounded council (self-abstain when your notes can't ground a take): ${onOff(s.councilGrounded, "set MUSE_A2A_COUNCIL_GROUNDED=true")}`,
    `  You are: ${s.selfId.length > 0 ? s.selfId : "(selfId unset in ~/.muse/a2a-peers.json)"}`,
    s.peers.length > 0
      ? `  Peers (${s.peers.length.toString()}): ${s.peers.map((p) => `${p.id} (${p.url})`).join(", ")}`
      : "  Peers:   (none — add them to ~/.muse/a2a-peers.json)",
    `  Quarantined know-how awaiting review: ${s.pendingCount.toString()}${s.pendingCount > 0 ? "  → muse swarm pending" : ""}`,
    "",
    "  Serve inbound:  muse swarm serve        Share a skill:  muse swarm share <skill> --to <peer>",
    "  Convene:        muse swarm council \"<question>\""
  ];
  return lines.join("\n");
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

/**
 * Test seam — inject a per-round gather function so the council action is
 * exercisable without a live model or peer HTTP. When provided, `gatherCouncil`
 * is not called; the override returns utterances directly for each round number
 * (1-indexed). Absent in production (falls through to real gatherCouncil).
 */
export type CouncilGatherOverride = (round: number, question: string, prior: readonly import("@muse/agent-core").CouncilUtterance[]) => Promise<import("@muse/agent-core").CouncilUtterance[]>;

export interface GatherCouncilDeps {
  readonly peers: readonly A2APeer[];
  readonly selfId: string;
  readonly requestReasoning: (peer: A2APeer, question: string) => Promise<string | null>;
  /** This Muse's own reasoning (so even a 1-peer council has ≥2 voices). */
  readonly ownReasoning?: () => Promise<string>;
}

/** Collect council utterances: this Muse's own reasoning + each peer's, dropping non-responders. */
export async function gatherCouncil(question: string, deps: GatherCouncilDeps): Promise<CouncilUtterance[]> {
  const utterances: CouncilUtterance[] = [];
  if (deps.ownReasoning) {
    const own = await deps.ownReasoning();
    if (own.trim().length > 0) utterances.push({ peerId: deps.selfId.length > 0 ? deps.selfId : "me", reasoning: own });
  }
  const peerResults = await Promise.all(
    deps.peers.map((peer) => deps.requestReasoning(peer, question).then((r) => (r && r.trim().length > 0 ? { peerId: peer.id, reasoning: r } : null)))
  );
  for (const r of peerResults) {
    if (r) utterances.push(r);
  }
  return utterances;
}

export function renderCouncilResult(question: string, utterances: readonly CouncilUtterance[], answer: CouncilAnswer | null): string {
  const members = utterances.map((u) => u.peerId).join(", ");
  const lines = [`🏛  Council on: ${question}`, `   ${utterances.length.toString()} member(s) weighed in: ${members}\n`];
  if (!answer) {
    lines.push("   (couldn't synthesise an answer from the council's reasoning.)");
    return lines.join("\n");
  }
  lines.push(`   ${answer.answer}`);
  if (answer.contributors.length > 0) {
    lines.push(`   — drawn from: ${answer.contributors.join(", ")}`);
  }
  return lines.join("\n");
}

export function registerSwarmCommands(program: Command, io: ProgramIO): void {
  const swarm = program
    .command("swarm")
    .description("Review know-how other Muses shared with you (A2A swarm — inbound is inert until you promote it)");

  swarm
    .command("status")
    .description("Show your swarm setup — A2A on/off, council, peers, and pending know-how")
    .action(async () => {
      const env = process.env;
      const config = await loadPeerConfig(peersFile());
      const pendingCount = listPending(await readQuarantine(quarantineFile())).length;
      io.stdout(`${renderSwarmStatus({
        councilEnabled: ["true", "1", "yes", "on"].includes((env.MUSE_A2A_COUNCIL ?? "").trim().toLowerCase()),
        councilGrounded: isCouncilGroundedMode(env),
        enabled: isA2AEnabled(env),
        pendingCount,
        peers: config.peers.map((p) => ({ id: p.id, url: p.url })),
        selfId: config.selfId
      })}\n`);
    });

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
      // Council participation is a SECOND opt-in: a council request triggers a
      // bounded, tool-free, PII-redacted reasoning step (no corpus dump, no
      // execution). In grounded mode this Muse self-ABSTAINS on a question its own
      // notes can't ground — an ignorant peer stays silent instead of injecting a
      // confident-but-ungrounded opinion (only the abstain/speak decision crosses
      // the wire; the corpus never does).
      const councilOn = ["true", "1", "yes", "on"].includes((env.MUSE_A2A_COUNCIL ?? "").trim().toLowerCase());
      let councilReason: ((question: string) => Promise<string>) | undefined;
      if (councilOn) {
        const assembly = createMuseRuntimeAssembly();
        const model = assembly.defaultModel;
        if (assembly.modelProvider && model) {
          const provider = assembly.modelProvider;
          councilReason = (question) =>
            councilMemberReasoning({ env, model, modelProvider: provider, reasoningQuestion: question, retrievalQuestion: question });
        }
      }
      const handler = createA2AHandler({
        agentCard: card,
        deposit: (input) => addToQuarantine(quarantineFile(), input).then(() => undefined),
        env,
        registry: config.registry,
        selfPeerId: config.selfId,
        ...(councilReason ? { councilReason } : {})
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
    .command("council <question>")
    .description("Ask your swarm peers to reason about a question and synthesise an answer (data-light — only reasoning crosses)")
    // Default 2: ReConcile consensus gate (arXiv:2309.13007) — agreed panel stops at round 1,
    // contested panel spends a 2nd debate round. Hard cap stays at 3.
    .option("--rounds <n>", "Maximum debate rounds — stops early when the panel agrees (ReConcile; default 2)", "2")
    .action(async (question: string, options: { readonly rounds: string }) => {
      const env = process.env;
      if (!isA2AEnabled(env)) {
        io.stderr("muse swarm council: the swarm is off — set MUSE_A2A_ENABLED=true to opt in.\n");
        process.exitCode = 1;
        return;
      }
      const config = await loadPeerConfig(peersFile());
      if (config.peers.length === 0) {
        io.stderr("muse swarm council: no peers configured — add them to ~/.muse/a2a-peers.json.\n");
        process.exitCode = 1;
        return;
      }
      const rounds = Math.max(1, Math.min(3, Math.trunc(Number.parseInt(options.rounds, 10) || 1)));

      let model: string | undefined;
      let modelProvider: Pick<ModelProvider, "generate"> | undefined;
      if (!io.councilGatherOverride) {
        const assembly = createMuseRuntimeAssembly();
        if (!assembly.modelProvider || !assembly.defaultModel) {
          io.stderr("muse swarm council: needs a configured local model (set MUSE_MODEL).\n");
          process.exitCode = 1;
          return;
        }
        model = assembly.defaultModel;
        modelProvider = assembly.modelProvider;
      }

      // Single gather closure: the override substitutes only this step;
      // the ONE debate loop below is shared by both test and production paths.
      const gather: CouncilGatherOverride = io.councilGatherOverride
        ?? (async (round, q, prior) =>
          gatherCouncil(q, {
            ownReasoning: () => councilMemberReasoning({
              env,
              model: model!,
              modelProvider: modelProvider!,
              reasoningQuestion: round === 1 ? q : buildDebateQuestion(q, config.selfId.length > 0 ? config.selfId : "me", prior),
              retrievalQuestion: question
            }),
            peers: config.peers,
            requestReasoning: (peer, pq) => requestCouncilReasoning({
              env,
              fetchImpl: io.fetch ?? globalThis.fetch,
              fromPeerId: config.selfId,
              peer,
              question: round === 1 ? pq : buildDebateQuestion(pq, peer.id, prior)
            }),
            selfId: config.selfId
          })
        );

      io.stdout(`🏛  Convening the council (${config.peers.length.toString()} peer(s)${rounds > 1 ? `, up to ${rounds.toString()} debate rounds` : ""})…\n`);
      let utterances = await gather(1, question, []);
      // ReConcile consensus gate (arXiv:2309.13007): stop as soon as the panel agrees —
      // avoids wasted inference when all members have already converged.
      let finalRound = 1;
      for (let round = 2; round <= rounds && utterances.length > 1 && !hasCouncilConsensus(utterances); round += 1) {
        io.stdout(`panel diverged — refining, round ${round.toString()}\n`);
        const prior = utterances;
        utterances = await gather(round, question, prior);
        finalRound = round;
      }
      if (utterances.length > 1 && hasCouncilConsensus(utterances)) {
        io.stdout(`panel agreed — stopping at round ${finalRound.toString()}\n`);
      }
      if (utterances.length === 0) {
        io.stdout("No council members responded (peers offline or council disabled on them).\n");
        return;
      }
      if (io.councilGatherOverride) {
        io.stdout(`${renderCouncilResult(question, utterances, null)}\n`);
        return;
      }
      // RGV re-verification: a one-shot local judge re-checks the synthesis
      // against the members' actual reasoning, dropping a "consensus" none reached.
      const reverify: GroundingReverify = async ({ answer: a, evidence, query }) => {
        const judged = await modelProvider!.generate({
          maxOutputTokens: 24,
          responseFormat: REVERIFY_RESPONSE_FORMAT,
          messages: [
            { content: REVERIFY_SYSTEM_PROMPT, role: "system" },
            { content: buildGroundingReverifyPrompt({ answer: a, evidence, query }), role: "user" }
          ],
          model: model!,
          temperature: 0
        });
        return parseGroundingReverifyJson(judged.output ?? "");
      };
      const answer = await synthesizeCouncilAnswer(question, utterances, { model: model!, modelProvider: modelProvider!, reverify });
      io.stdout(`${renderCouncilResult(question, utterances, answer)}\n`);
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
