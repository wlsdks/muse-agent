import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPeerRegistry, receiveAndQuarantine, sendToPeer } from "@muse/a2a";
import { addToQuarantine, listPending, readQuarantine } from "@muse/stores";
import { AuthoredSkillStore } from "@muse/skills";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventEmitter } from "node:events";

import { buildSwarmSkillDraft, gatherCouncil, readSwarmBody, registerSwarmCommands, renderCouncilResult, renderPending, renderShareDraft, type CouncilGatherOverride } from "./commands-swarm.js";
import type { ProgramIO } from "./program.js";
import { hasCouncilConsensus, type CouncilUtterance } from "@muse/agent-core";

describe("readSwarmBody — inbound A2A body is size-capped (no unbounded accumulation)", () => {
  class MockReq extends EventEmitter {
    destroyed = false;
    destroyError: Error | undefined;
    destroy(err?: Error): void {
      this.destroyed = true;
      this.destroyError = err;
      this.emit("error", err);
    }
  }

  it("resolves the full body when under the cap", async () => {
    const req = new MockReq();
    const p = readSwarmBody(req as unknown as import("node:http").IncomingMessage, 1024);
    req.emit("data", Buffer.from("hello "));
    req.emit("data", Buffer.from("world"));
    req.emit("end");
    await expect(p).resolves.toBe("hello world");
    expect(req.destroyed).toBe(false);
  });

  it("destroys the request and rejects once the byte cap is exceeded", async () => {
    const req = new MockReq();
    const p = readSwarmBody(req as unknown as import("node:http").IncomingMessage, 8);
    // First chunk fits, second blows the cap — the old code would keep
    // accumulating unbounded; the guard must destroy + reject here.
    req.emit("data", Buffer.from("12345"));
    req.emit("data", Buffer.from("67890"));
    await expect(p).rejects.toThrow("payload too large");
    expect(req.destroyed).toBe(true);
  });

  it("defaults to a 1 MiB cap — a >1 MiB body is rejected", async () => {
    const req = new MockReq();
    const p = readSwarmBody(req as unknown as import("node:http").IncomingMessage);
    req.emit("data", Buffer.alloc(1024 * 1024 + 1));
    await expect(p).rejects.toThrow("payload too large");
    expect(req.destroyed).toBe(true);
  });
});

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

  it("weak consensus → renders advisory line; strong or omitted → does not", () => {
    const us = [{ peerId: "a", reasoning: "x" }, { peerId: "b", reasoning: "y" }];
    const weakOut = renderCouncilResult("q?", us, { answer: "x", contributors: [], consensus: "weak" });
    expect(weakOut).toContain("weak consensus");
    const strongOut = renderCouncilResult("q?", us, { answer: "x", contributors: [], consensus: "strong" });
    expect(strongOut).not.toContain("weak consensus");
    const noFieldOut = renderCouncilResult("q?", us, { answer: "x", contributors: [] });
    expect(noFieldOut).not.toContain("weak consensus");
  });

  it("dissenting peers → renders the 'dissent set aside' advisory naming them; empty → no line (Hear Both Sides 2603.20640)", () => {
    const us = [{ peerId: "a", reasoning: "x" }, { peerId: "carol", reasoning: "y" }];
    const ans = { answer: "x", contributors: ["a"] };
    const withDissent = renderCouncilResult("q?", us, ans, [], ["carol"]);
    expect(withDissent).toContain("dissent set aside");
    expect(withDissent).toContain("carol");
    const noDissent = renderCouncilResult("q?", us, ans, [], []);
    expect(noDissent).not.toContain("dissent set aside");
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

  // Fake embedder: texts mentioning PostgreSQL → [1,0,0]; anything else → [0,1,0].
  // AGREEING panel: all mention PostgreSQL → cosine=1 → consensus.
  // DIVERGING panel: PostgreSQL + Bananas → orthogonal → no consensus.
  const fakeEmbed = async (text: string): Promise<readonly number[]> =>
    text.toLowerCase().includes("postgresql") ? [1, 0, 0] : [0, 1, 0];

  const makeProgram = (gatherOverride: CouncilGatherOverride) => {
    const io: ProgramIO = {
      councilEmbedOverride: fakeEmbed,
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

  it("flat never-converging fixtures → non-progress early-stop before the round cap (MAST step-repetition)", async () => {
    let callCount = 0;
    const gatherOverride: CouncilGatherOverride = async (_round) => {
      callCount += 1;
      return [...DIVERGING]; // identical every round → consensus score is FLAT
    };
    await makeProgram(gatherOverride).parseAsync(["node", "x", "swarm", "council", "--rounds", "3", "which database?"], { from: "node" });
    // A round that gains no consensus is non-progress: the loop stops at round 2
    // instead of burning round 3 on a panel that isn't converging.
    expect(callCount).toBe(2);
    const text = out.join("");
    expect(text).toContain("not converging");
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

// ── Semantic consensus gate: cross-lingual (KO+EN) assembled-path ──
// arXiv:2309.13007 (ReConcile) + arXiv:2507.14649 (Cleanse)

describe("muse swarm council — semantic consensus gate (KO+EN cross-lingual, assembled-path)", () => {
  let dir: string;
  let out: string[];
  const prevEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { prevEnv[k] = process.env[k]; process.env[k] = v; };

  // KO+EN agreeing paraphrases of the same answer — the cross-lingual fixture.
  // Jaccard scores ~0 (zero token overlap across scripts); cosine scores ~1 (same meaning).
  const KO_REASONING = "PostgreSQL이 동시 쓰기와 관계형 무결성을 잘 처리하므로 선택해야 합니다.";
  const EN_REASONING = "PostgreSQL is the right choice because it handles concurrent writes and relational integrity well.";
  const KO_EN_AGREEING: readonly CouncilUtterance[] = [
    { peerId: "ko-device", reasoning: KO_REASONING },
    { peerId: "en-device", reasoning: EN_REASONING }
  ];

  // Fake embedder returns the same vector for all texts → cosine = 1 → always consensus.
  const agreeEmbed = async (_text: string): Promise<readonly number[]> => [1, 0, 0];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-council-ko-en-"));
    out = [];
    setEnv("MUSE_A2A_ENABLED", "true");
    setEnv("MUSE_A2A_PEERS_FILE", join(dir, "a2a-peers.json"));
    await writeFile(join(dir, "a2a-peers.json"), JSON.stringify({
      peers: [{ id: "en-device", secret: "s1", url: "https://en-device.test/a2a" }],
      selfId: "ko-device"
    }), "utf8");
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(dir, { force: true, recursive: true });
  });

  it("KO+EN agreeing panel: Jaccard scores ~0 (cross-script false-negative — documented bug)", () => {
    // Counterfactual: Jaccard would report false → loop would run round 2 → gatherFn called TWICE.
    expect(hasCouncilConsensus([...KO_EN_AGREEING])).toBe(false);
  });

  it("KO+EN agreeing panel with semantic embedder → gatherFn called ONCE (consensus at round 1)", async () => {
    let callCount = 0;
    const gatherOverride: CouncilGatherOverride = async () => {
      callCount += 1;
      return [...KO_EN_AGREEING];
    };
    const io: ProgramIO = {
      councilEmbedOverride: agreeEmbed,
      councilGatherOverride: gatherOverride,
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      readPipedStdin: async () => "",
      stderr: (m: string) => out.push(m),
      stdout: (m: string) => out.push(m)
    } as unknown as ProgramIO;
    const cmd = new Command();
    registerSwarmCommands(cmd, io);
    await cmd.parseAsync(["node", "x", "swarm", "council", "which database?"], { from: "node" });
    // Semantic gate recognizes agreement → loop never enters → gather called only once.
    expect(callCount).toBe(1);
    const text = out.join("");
    expect(text).toContain("panel agreed — stopping at round 1");
    expect(text).not.toContain("refining, round 2");
  });
});

// ── Semantic outlier screen assembled-path — swarm council with injected embed ──
// Proves the live wiring: councilSynthesisOverride + councilGatherOverride together
// exercise the full synthesis path (including screenCouncilOutliers) without Ollama.

describe("muse swarm council — semantic outlier screen assembled-path (fire-28 fix, no Ollama)", () => {
  let dir: string;
  let out: string[];
  const prevEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { prevEnv[k] = process.env[k]; process.env[k] = v; };

  const AGREE_VEC = [1, 0.1, 0.1, 0.0];

  const KO_EN_PANEL: CouncilUtterance[] = [
    { peerId: "ko1", reasoning: "PostgreSQL이 동시 쓰기를 잘 처리합니다." },
    { peerId: "ko2", reasoning: "관계형 무결성 때문에 PostgreSQL을 선택해야 합니다." },
    { peerId: "en",  reasoning: "PostgreSQL handles concurrent writes reliably." }
  ];

  beforeEach(async () => {
    dir = await (await import("node:fs/promises")).mkdtemp((await import("node:path")).join((await import("node:os")).tmpdir(), "muse-semantic-"));
    out = [];
    setEnv("MUSE_A2A_ENABLED", "true");
    setEnv("MUSE_A2A_PEERS_FILE", (await import("node:path")).join(dir, "a2a-peers.json"));
    await (await import("node:fs/promises")).writeFile(
      (await import("node:path")).join(dir, "a2a-peers.json"),
      JSON.stringify({ peers: [{ id: "phone", secret: "s1", url: "https://phone.test/a2a" }, { id: "server", secret: "s2", url: "https://server.test/a2a" }], selfId: "laptop" }),
      "utf8"
    );
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await (await import("node:fs/promises")).rm(dir, { force: true, recursive: true });
  });

  it("KO+EN agreeing panel reaches synthesis with no false quarantine in excludedPeers", async () => {
    // All three peers get the same vector → cosine ~1.0 → all KEPT (no false quarantine)
    const fakeEmbed = async (_text: string): Promise<readonly number[]> => AGREE_VEC;
    let synthPromptSeen = "";
    let callCount = 0;
    const fakeModelProvider = {
      generate: async (req: { messages: { role: string; content: string }[] }) => {
        callCount++;
        if (callCount === 1) {
          // Synthesis call
          synthPromptSeen = req.messages.find((m) => m.role === "user")?.content ?? "";
          return { id: "r", model: "m", output: '{"answer":"Use PostgreSQL for concurrent writes.","contributors":["ko1","ko2","en"]}' };
        }
        // Reverify call — return supported=true
        return { id: "r", model: "m", output: '{"supported":true}' };
      },
      id: "fake",
      listModels: async () => [],
      stream: async function* () { yield { type: "text" as const, text: "" }; }
    } as never;

    const gatherOverride: CouncilGatherOverride = async (_round) => KO_EN_PANEL;

    const io: ProgramIO = {
      councilGatherOverride: gatherOverride,
      councilSynthesisOverride: { embed: fakeEmbed, model: "m", modelProvider: fakeModelProvider },
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      readPipedStdin: async () => "",
      stderr: (m: string) => out.push(m),
      stdout: (m: string) => out.push(m)
    } as unknown as ProgramIO;
    const cmd = new Command();
    registerSwarmCommands(cmd, io);
    await cmd.parseAsync(["node", "x", "swarm", "council", "which database?"], { from: "node" });

    const text = out.join("");
    expect(text).toContain("Use PostgreSQL for concurrent writes.");
    // EN peer's reasoning appeared in synthesis prompt (not quarantined)
    expect(synthPromptSeen).toContain("PostgreSQL handles concurrent writes reliably.");
    // No false exclusion of the EN peer
    expect(text).not.toContain("excludedPeers"); // JSON not surfaced in render
  });
});

// Assembled-path: a peer that reaches agreement by abandoning its own stance
// (conformity) surfaces a caution (arXiv:2606.00820). Drives the REAL swarm command
// loop → detectConformityFlips → renderCouncilResult.
describe("muse swarm council — conformity-driven agreement caution (assembled, no Ollama)", () => {
  let dir: string;
  let out: string[];
  const prevEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { prevEnv[k] = process.env[k]; process.env[k] = v; };

  // Stance space: "for" → [1,0], "against" → [0,1]. B reverses against→for in round 2.
  const stanceEmbed = async (text: string): Promise<readonly number[]> =>
    text.includes("against") ? [0, 1] : [1, 0];
  const ROUND1: CouncilUtterance[] = [
    { peerId: "laptop", reasoning: "for: ship today" },
    { peerId: "phone", reasoning: "for: ship today" },
    { peerId: "server", reasoning: "against: wait a day" }
  ];
  const ROUND2: CouncilUtterance[] = [
    { peerId: "laptop", reasoning: "for: ship today" },
    { peerId: "phone", reasoning: "for: ship today" },
    { peerId: "server", reasoning: "for: ship today" } // server abandoned its stance
  ];

  const fakeModelProvider = (() => {
    let n = 0;
    return {
      generate: async () => {
        n++;
        return n === 1
          ? { id: "r", model: "m", output: '{"answer":"Ship today.","contributors":["laptop","phone","server"]}' }
          : { id: "r", model: "m", output: '{"supported":true}' };
      },
      id: "fake", listModels: async () => [], stream: async function* () { yield { type: "text" as const, text: "" }; }
    } as never;
  })();

  beforeEach(async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    dir = await mkdtemp(join(tmpdir(), "muse-conformity-"));
    out = [];
    setEnv("MUSE_A2A_ENABLED", "true");
    setEnv("MUSE_A2A_PEERS_FILE", join(dir, "a2a-peers.json"));
    await writeFile(join(dir, "a2a-peers.json"), JSON.stringify({ peers: [{ id: "phone", secret: "s1", url: "https://phone.test/a2a" }, { id: "server", secret: "s2", url: "https://server.test/a2a" }], selfId: "laptop" }), "utf8");
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await (await import("node:fs/promises")).rm(dir, { force: true, recursive: true });
  });

  it("warns when the panel agrees only because a peer dropped its own stance", async () => {
    const gatherOverride: CouncilGatherOverride = async (round) => (round === 1 ? ROUND1 : ROUND2);
    const io = {
      councilGatherOverride: gatherOverride,
      councilSynthesisOverride: { embed: stanceEmbed, model: "m", modelProvider: fakeModelProvider },
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      readPipedStdin: async () => "",
      stderr: (m: string) => out.push(m),
      stdout: (m: string) => out.push(m)
    } as unknown as ProgramIO;
    const cmd = new Command();
    registerSwarmCommands(cmd, io);
    await cmd.parseAsync(["node", "x", "swarm", "council", "--rounds", "2", "should we ship?"], { from: "node" });
    const text = out.join("");
    expect(text).toContain("Ship today."); // synthesis happened
    expect(text).toContain("conformity-driven agreement"); // the caution fired
    expect(text).toContain("server"); // names the conforming peer
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

// ── Semantic question-relevance gate assembled-path (fire-39 redo, no Ollama) ──
// Proves the gate runs on the live `muse swarm council` path via the
// councilSynthesisOverride seam + fake embedder + fake provider.

describe("muse swarm council — question-relevance gate assembled-path (fire-39 semantic redo, no Ollama)", () => {
  let dir: string;
  let out: string[];
  const prevEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { prevEnv[k] = process.env[k]; process.env[k] = v; };

  // Controlled vectors: question + on-topic peers → cosine ~0.9; off-topic → ~0.05
  const Q_VEC    = [1.0, 0.0, 0.0, 0.0];
  const ON_VEC   = [0.9, 0.3, 0.1, 0.0];
  const OFF_VEC  = [0.05, 0.05, 0.05, 1.0];

  const MIXED_PANEL: CouncilUtterance[] = [
    { peerId: "ko1", reasoning: "PostgreSQL이 동시 쓰기를 잘 처리합니다." },
    { peerId: "en1", reasoning: "PostgreSQL handles concurrent writes reliably." },
    { peerId: "off", reasoning: "바나나는 노란 열대 과일입니다." }
  ];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-relevance-gate-"));
    out = [];
    setEnv("MUSE_A2A_ENABLED", "true");
    setEnv("MUSE_A2A_PEERS_FILE", join(dir, "a2a-peers.json"));
    await writeFile(join(dir, "a2a-peers.json"), JSON.stringify({
      peers: [{ id: "phone", secret: "s1", url: "https://phone.test/a2a" }],
      selfId: "laptop"
    }), "utf8");
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(dir, { force: true, recursive: true });
  });

  it("off-topic peer (low question cosine) → excluded with 'off-topic', synthesis only on on-topic subset", async () => {
    const question = "which database?";
    const vecMap = new Map<string, readonly number[]>([
      [question, Q_VEC],
      ["PostgreSQL이 동시 쓰기를 잘 처리합니다.", ON_VEC],
      ["PostgreSQL handles concurrent writes reliably.", ON_VEC],
      ["바나나는 노란 열대 과일입니다.", OFF_VEC]
    ]);
    const fakeEmbed = async (text: string): Promise<readonly number[]> => {
      return vecMap.get(text) ?? ON_VEC;
    };

    let synthPromptSeen = "";
    let callCount = 0;
    const fakeModelProvider = {
      generate: async (req: { messages: { role: string; content: string }[] }) => {
        callCount++;
        if (callCount === 1) {
          synthPromptSeen = req.messages.find((m) => m.role === "user")?.content ?? "";
          return { id: "r", model: "m", output: '{"answer":"Use PostgreSQL.","contributors":["ko1","en1"]}' };
        }
        return { id: "r", model: "m", output: '{"supported":true}' };
      },
      id: "fake",
      listModels: async () => [],
      stream: async function* () { yield { type: "text" as const, text: "" }; }
    } as never;

    const gatherOverride: CouncilGatherOverride = async (_round) => MIXED_PANEL;

    const io: ProgramIO = {
      councilGatherOverride: gatherOverride,
      councilSynthesisOverride: { embed: fakeEmbed, model: "m", modelProvider: fakeModelProvider },
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      readPipedStdin: async () => "",
      stderr: (m: string) => out.push(m),
      stdout: (m: string) => out.push(m)
    } as unknown as ProgramIO;

    const cmd = new Command();
    registerSwarmCommands(cmd, io);
    await cmd.parseAsync(["node", "x", "swarm", "council", question], { from: "node" });

    // Synthesis received the on-topic peers' reasoning
    expect(synthPromptSeen).toContain("PostgreSQL이 동시 쓰기를 잘 처리합니다.");
    expect(synthPromptSeen).toContain("PostgreSQL handles concurrent writes reliably.");
    // Off-topic peer's reasoning was NOT in synthesis prompt
    expect(synthPromptSeen).not.toContain("바나나는 노란 열대 과일입니다.");
    // The answer was rendered
    const text = out.join("");
    expect(text).toContain("Use PostgreSQL.");
  });
});
