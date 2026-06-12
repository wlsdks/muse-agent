import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPeerRegistry, receiveAndQuarantine, sendToPeer } from "@muse/a2a";
import { addToQuarantine, listPending, readQuarantine } from "@muse/mcp";
import { AuthoredSkillStore } from "@muse/skills";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSwarmSkillDraft, gatherCouncil, registerSwarmCommands, renderCouncilResult, renderPending, renderShareDraft, type CouncilGatherOverride } from "./commands-swarm.js";
import type { ProgramIO } from "./program.js";

describe("gatherCouncil + renderCouncilResult", () => {
  const peer = (id: string) => ({ id, secret: "s", url: `https://${id}/a2a` });

  it("collects own reasoning + each responding peer, dropping non-responders", async () => {
    const utterances = await gatherCouncil("rent or buy?", {
      ownReasoning: async () => "my own take",
      peers: [peer("phone"), peer("server"), peer("offline")],
      requestReasoning: async (p) => (p.id === "offline" ? null : `${p.id} says buy`),
      selfId: "laptop"
    });
    expect(utterances.map((u) => u.peerId)).toEqual(["laptop", "phone", "server"]); // self first, offline dropped
    expect(utterances[0]!.reasoning).toBe("my own take");
  });

  it("uses 'me' when selfId is unset, and skips an empty own reasoning", async () => {
    const u1 = await gatherCouncil("q", { ownReasoning: async () => "   ", peers: [peer("phone")], requestReasoning: async () => "x", selfId: "" });
    expect(u1.map((u) => u.peerId)).toEqual(["phone"]); // empty own dropped
    const u2 = await gatherCouncil("q", { ownReasoning: async () => "mine", peers: [], requestReasoning: async () => null, selfId: "" });
    expect(u2[0]!.peerId).toBe("me");
  });

  it("renders the answer + contributors, and a graceful message on null", () => {
    const us = [{ peerId: "laptop", reasoning: "a" }, { peerId: "phone", reasoning: "b" }];
    const out = renderCouncilResult("rent or buy?", us, { answer: "Rent for flexibility.", contributors: ["laptop", "phone"] });
    expect(out).toContain("Council on: rent or buy?");
    expect(out).toContain("2 member(s) weighed in: laptop, phone");
    expect(out).toContain("Rent for flexibility.");
    expect(out).toContain("drawn from: laptop, phone");
    expect(renderCouncilResult("q", us, null)).toContain("couldn't synthesise");
  });
});

const SHARED = "swarm-secret";
const ON = { MUSE_A2A_ENABLED: "true" } as const;

describe("renderPending", () => {
  it("shows nothing when empty, lists pending with promote/reject hints otherwise", () => {
    expect(renderPending([])).toContain("No quarantined know-how");
    const out = renderPending([
      { content: "set MTU 1380 on wg0", fromPeerId: "phone", id: "abcd1234ef", kind: "skill", receivedAtMs: Date.parse("2026-05-30T09:00:00Z"), status: "pending" }
    ]);
    expect(out).toContain("[abcd1234]");
    expect(out).toContain("from phone");
    expect(out).toContain("muse swarm promote <id>");
  });
});

describe("renderShareDraft", () => {
  it("previews the redacted content + the target peer and says nothing was sent", () => {
    const out = renderShareDraft({ content: "set MTU 1380", peerId: "phone", redacted: true, skillName: "vpn-fix" });
    expect(out).toContain("peer 'phone'");
    expect(out).toContain("vpn-fix");
    expect(out).toContain("secret was redacted");
    expect(out).toContain("Re-run with --yes");
  });
});

describe("muse swarm share — draft-first outbound", () => {
  let dir: string;
  let out: string[];
  let posts: { url: string; body: string }[];
  const prevEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { prevEnv[k] = process.env[k]; process.env[k] = v; };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-share-"));
    out = [];
    posts = [];
    setEnv("MUSE_A2A_ENABLED", "true");
    setEnv("MUSE_A2A_PEERS_FILE", join(dir, "a2a-peers.json"));
    setEnv("MUSE_AUTHORED_SKILLS_DIR", join(dir, "authored"));
    await writeFile(join(dir, "a2a-peers.json"), JSON.stringify({
      peers: [{ id: "phone", secret: "shared-secret", url: "https://phone.test/a2a" }],
      selfId: "laptop"
    }), "utf8");
    await new AuthoredSkillStore({ dir: join(dir, "authored") }).writeOrPatch({
      body: "Set MTU 1380 on wg0. key=sk-proj-AbCdEf0123456789GhIjKl0123456789",
      description: "fix vpn",
      name: "vpn-fix"
    });
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(dir, { force: true, recursive: true });
  });

  const program = (): { cmd: Command; io: ProgramIO } => {
    const io = {
      fetch: (async (url: string, init?: RequestInit) => { posts.push({ body: String(init?.body), url: String(url) }); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch,
      readPipedStdin: async () => "",
      stderr: (m: string) => out.push(m),
      stdout: (m: string) => out.push(m)
    } as unknown as ProgramIO;
    const cmd = new Command();
    registerSwarmCommands(cmd, io);
    return { cmd, io };
  };

  it("WITHOUT --yes: prints the draft (PII redacted) and sends NOTHING", async () => {
    await program().cmd.parseAsync(["node", "x", "swarm", "share", "vpn-fix", "--to", "phone"], { from: "node" });
    const text = out.join("");
    expect(text).toContain("Draft");
    expect(text).toContain("MTU 1380");
    expect(text).not.toContain("sk-proj-AbCdEf0123456789GhIjKl0123456789"); // redacted in the preview
    expect(posts).toHaveLength(0);
  });

  it("WITH --yes: sends the redacted skill to the peer as an A2A message/send", async () => {
    await program().cmd.parseAsync(["node", "x", "swarm", "share", "vpn-fix", "--to", "phone", "--yes"], { from: "node" });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://phone.test/a2a");
    const body = JSON.parse(posts[0]!.body) as { method: string; params: { message: { parts: { data: { content: string; kind: string } }[] } } };
    expect(body.method).toBe("message/send");
    const data = body.params.message.parts[0]!.data;
    expect(data.kind).toBe("skill");
    expect(data.content).toContain("MTU 1380");
    expect(data.content).not.toContain("sk-proj-AbCdEf0123456789GhIjKl0123456789"); // PII never crossed the wire
  });

  it("unknown peer → error, no send", async () => {
    await program().cmd.parseAsync(["node", "x", "swarm", "share", "vpn-fix", "--to", "nobody", "--yes"], { from: "node" });
    expect(out.join("")).toMatch(/unknown peer/);
    expect(posts).toHaveLength(0);
  });
});

describe("personal swarm — send → quarantine → promote (end to end)", () => {
  let dir: string;
  let quarantineFile: string;
  let authoredDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-swarm-"));
    quarantineFile = join(dir, "swarm-quarantine.json");
    authoredDir = join(dir, "authored");
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("a skill shared by peer A lands quarantined on peer B and runs nothing until promoted", async () => {
    // Peer A (phone) shares a skill to peer B (laptop). Capture the real A2A POST.
    let posted: { body: string; sig: string } | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      posted = { body: String(init?.body), sig: String((init?.headers as Record<string, string>)["x-muse-a2a-signature"]) };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await sendToPeer({
      env: ON,
      fetchImpl,
      fromPeerId: "phone",
      outbound: { content: "# VPN fix\nSet MTU 1380 on wg0 and restart wireguard.", kind: "skill" },
      peer: { id: "laptop", secret: SHARED, url: "https://laptop.test/a2a" }
    });
    expect(posted).toBeDefined();

    // Peer B (laptop) receives it: the safety core classifies → quarantine → deposit.
    const receiverRegistry = createPeerRegistry([{ id: "phone", secret: SHARED, url: "https://phone.test/a2a" }]);
    const decision = await receiveAndQuarantine({
      deposit: (i) => addToQuarantine(quarantineFile, i).then(() => undefined),
      env: ON,
      rawBody: posted!.body,
      registry: receiverRegistry,
      signature: posted!.sig
    });
    expect(decision.disposition).toBe("quarantine");

    // It is PENDING — inert, not yet an authored skill.
    const pending = listPending(await readQuarantine(quarantineFile));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.fromPeerId).toBe("phone");
    const store = new AuthoredSkillStore({ dir: authoredDir });
    expect(await store.listAuthored()).toHaveLength(0); // nothing authored yet

    // Promote it → execute-gated authored skill.
    const res = await store.writeOrPatch(buildSwarmSkillDraft(pending[0]!));
    expect(res.action).toBeTruthy();
    const authored = await store.listAuthored();
    expect(authored).toHaveLength(1);
    expect(authored[0]!.body).toContain("MTU 1380"); // the shared know-how is now available as guidance
    // Execute-gate: a SkillDraft has no `requires`, so the promoted skill can
    // never declare runnable bins → muse.skills.run refuses to execute it.
    expect(authored[0]!.frontmatter.requires).toBeUndefined();
  });
});

// ── ReConcile consensus-gated round budget — assembled-path counterfactual ──
// Uses the councilGatherOverride seam so the REAL registered action exercises
// the consensus gate without a live model or peer HTTP.

describe("muse swarm council — ReConcile consensus gate (assembled-path, no Ollama)", () => {
  let dir: string;
  let out: string[];
  const prevEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { prevEnv[k] = process.env[k]; process.env[k] = v; };

  const AGREEING = [
    { peerId: "laptop", reasoning: "The database should use PostgreSQL because it handles concurrent writes and relational integrity well." },
    { peerId: "phone",  reasoning: "PostgreSQL is the better choice given its reliable handling of concurrent writes." },
    { peerId: "server", reasoning: "For this use case, PostgreSQL handles concurrent writes reliably and is the right pick." }
  ];
  const DIVERGING = [
    { peerId: "laptop", reasoning: "The database should use PostgreSQL because it handles concurrent writes and relational integrity well." },
    { peerId: "phone",  reasoning: "Bananas are yellow tropical fruit grown in warm climates near the equator." }
  ];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-council-"));
    out = [];
    setEnv("MUSE_A2A_ENABLED", "true");
    setEnv("MUSE_A2A_PEERS_FILE", join(dir, "a2a-peers.json"));
    await writeFile(join(dir, "a2a-peers.json"), JSON.stringify({
      peers: [
        { id: "phone", secret: "s1", url: "https://phone.test/a2a" },
        { id: "server", secret: "s2", url: "https://server.test/a2a" }
      ],
      selfId: "laptop"
    }), "utf8");
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(dir, { force: true, recursive: true });
  });

  const makeProgram = (gatherOverride: CouncilGatherOverride) => {
    const io: ProgramIO = {
      councilGatherOverride: gatherOverride,
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      readPipedStdin: async () => "",
      stderr: (m: string) => out.push(m),
      stdout: (m: string) => out.push(m)
    } as unknown as ProgramIO;
    const cmd = new Command();
    registerSwarmCommands(cmd, io);
    return cmd;
  };

  it("DIVERGING peers + default rounds → gatherFn called TWICE (loop fires by default)", async () => {
    let callCount = 0;
    const gatherOverride: CouncilGatherOverride = async (round) => {
      callCount += 1;
      // round 1: diverging; round 2: still diverging (reaches cap)
      return round === 1 ? [...DIVERGING] : [...DIVERGING];
    };
    await makeProgram(gatherOverride).parseAsync(["node", "x", "swarm", "council", "which database?"], { from: "node" });
    // Default is 2 rounds; diverging panel → loop runs round 2 → gather called twice
    expect(callCount).toBe(2);
    const text = out.join("");
    expect(text).toContain("refining, round 2"); // audit trail: loop ran
  });

  it("AGREEING peers + default rounds → gatherFn called ONCE (consensus short-circuits)", async () => {
    let callCount = 0;
    const gatherOverride: CouncilGatherOverride = async (_round) => {
      callCount += 1;
      return [...AGREEING];
    };
    await makeProgram(gatherOverride).parseAsync(["node", "x", "swarm", "council", "which database?"], { from: "node" });
    // Panel agrees after round 1 → loop never enters → gather called only once
    expect(callCount).toBe(1);
    const text = out.join("");
    expect(text).toContain("panel agreed — stopping at round 1");
    expect(text).not.toContain("refining, round 2");
  });

  it("--rounds 3 + consensus reached after round 2 → stops at round 2 (early termination)", async () => {
    let callCount = 0;
    const gatherOverride: CouncilGatherOverride = async (round) => {
      callCount += 1;
      // round 1: diverging; round 2: panel agrees
      return round === 1 ? [...DIVERGING] : [...AGREEING];
    };
    await makeProgram(gatherOverride).parseAsync(["node", "x", "swarm", "council", "--rounds", "3", "which database?"], { from: "node" });
    expect(callCount).toBe(2); // stopped at round 2, never reached round 3
    const text = out.join("");
    expect(text).toContain("panel agreed — stopping at round 2");
    expect(text).not.toContain("refining, round 3");
  });

  it("never-converging fixtures → hard stop at cap 3", async () => {
    let callCount = 0;
    const gatherOverride: CouncilGatherOverride = async (_round) => {
      callCount += 1;
      return [...DIVERGING]; // always diverging
    };
    await makeProgram(gatherOverride).parseAsync(["node", "x", "swarm", "council", "--rounds", "3", "which database?"], { from: "node" });
    expect(callCount).toBe(3); // ran all 3 rounds
    const text = out.join("");
    expect(text).not.toContain("panel agreed"); // no consensus reached
  });

  it("failed/empty peer in round 2 → degrades gracefully, never throws", async () => {
    let callCount = 0;
    const gatherOverride: CouncilGatherOverride = async (round) => {
      callCount += 1;
      if (round === 2) {
        // Only one responder in round 2 (peer failed) — loop exits because utterances.length <= 1
        return [{ peerId: "laptop", reasoning: "Only one voice remains." }];
      }
      return [...DIVERGING];
    };
    await expect(
      makeProgram(gatherOverride).parseAsync(["node", "x", "swarm", "council", "which database?"], { from: "node" })
    ).resolves.not.toThrow();
    expect(callCount).toBe(2);
    const text = out.join("");
    expect(text).toContain("Council on:"); // result still rendered
  });
});

describe("renderSwarmStatus", () => {
  it("shows on/off hints, peers, and the pending count", async () => {
    const { renderSwarmStatus } = await import("./commands-swarm.js");
    const out = renderSwarmStatus({ councilEnabled: false, councilGrounded: true, enabled: true, pendingCount: 2, peers: [{ id: "phone", url: "https://phone/a2a" }], selfId: "laptop" });
    expect(out).toContain("A2A:     ON");
    expect(out).toContain("Council: OFF (set MUSE_A2A_COUNCIL=true)");
    expect(out).toContain("Grounded council");
    expect(out).toContain("ON");
    expect(out).toContain("You are: laptop");
    expect(out).toContain("phone (https://phone/a2a)");
    expect(out).toContain("Quarantined know-how awaiting review: 2");
  });
  it("guides setup when nothing is configured", async () => {
    const { renderSwarmStatus } = await import("./commands-swarm.js");
    const out = renderSwarmStatus({ councilEnabled: false, councilGrounded: false, enabled: false, pendingCount: 0, peers: [], selfId: "" });
    expect(out).toContain("A2A:     OFF (set MUSE_A2A_ENABLED=true)");
    expect(out).toContain("Grounded council (self-abstain when your notes can't ground a take): OFF");
    expect(out).toContain("selfId unset");
    expect(out).toContain("(none — add them");
  });
});
