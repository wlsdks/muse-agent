import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { casualResponseFor, UNGROUNDABLE_ANSWER_NOTICE, unbackedActionNoticeFor } from "@muse/agent-core";
import { LogMessagingProvider, MessagingProviderRegistry, recordPendingApproval } from "@muse/messaging";
import { appendLastProactiveDelivery, avoidedSourceKeys, readTrustLedger } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { createInboundAgentRun } from "../src/inbound-agent-run.js";

// The channel reply surface (Telegram et al.) answers with the FULL agent, so
// its output must pass the SAME deterministic grounding + citation gate the
// API /chat and CLI chat surfaces apply: a citation naming a source the run
// never produced is dropped BY CODE before the reply leaves for the channel,
// and a properly grounded answer passes through byte-identical.

const NOW = () => new Date("2026-07-11T09:00:00.000Z");

function buildRun(result: {
  readonly output: string;
  readonly groundingSources?: readonly { readonly source: string; readonly text: string }[];
  readonly toolsUsed?: readonly string[];
}) {
  const dir = mkdtempSync(join(tmpdir(), "muse-inbound-gate-"));
  const registry = new MessagingProviderRegistry([
    new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
  ]);
  const agentRuntime = {
    run: async () => ({
      response: { output: result.output },
      ...(result.groundingSources ? { groundingSources: result.groundingSources } : {}),
      ...(result.toolsUsed ? { toolsUsed: result.toolsUsed } : {})
    })
  };
  const env = {
    MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
    MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
    MUSE_PENDING_APPROVALS_FILE: join(dir, "pending.json")
  };
  return createInboundAgentRun({ agentRuntime, env, model: "default", registry });
}

describe("createInboundAgentRun grounding gate (channel-reply parity with /chat)", () => {
  it("drops a fabricated citation by code — the hedge reaches the channel, not the invented claim", async () => {
    const run = buildRun({ output: "Your rent is 900,000 KRW [from notes/rent.md]." });
    const reply = await run({
      messages: [{ content: "what is my rent?", role: "user" }],
      providerId: "log",
      scope: "direct",
      source: "42"
    });
    expect(reply).not.toContain("900,000");
    expect(reply).toBe(UNGROUNDABLE_ANSWER_NOTICE);
  });

  it("passes a grounded answer through byte-identical", async () => {
    const answer = "Your rent is 900,000 KRW [from rent.md].";
    const run = buildRun({
      groundingSources: [{ source: "/home/u/.muse/notes/rent.md", text: "rent is 900,000 KRW" }],
      output: answer
    });
    const reply = await run({
      messages: [{ content: "what is my rent?", role: "user" }],
      providerId: "log",
      scope: "direct",
      source: "42"
    });
    expect(reply).toBe(answer);
  });

  it("returns an empty reply unchanged (no hedge invented for a silent turn)", async () => {
    const run = buildRun({ output: "" });
    const reply = await run({
      messages: [{ content: "ok", role: "user" }],
      providerId: "log",
      scope: "direct",
      source: "42"
    });
    expect(reply).toBe("");
  });
});

// The honest-action gate (`honest-action-guard.ts`): a channel reply can
// CLAIM a completed state-changing action ("일정을 등록했습니다") while NO
// actuator tool ran this turn — the same false-completion class the API
// /chat surface is gated against. A live probe against the real server
// found exactly this: `toolCalls: null` paired with a confident "등록했습니다".
const KO_QUERY = "내일 오후 3시에 치과 예약 잡아줘";
const KO_CLAIM = "내일 오후 3시에 '치과 예약'을 등록했습니다.";

describe("createInboundAgentRun honest-action gate (channel-reply parity with /chat)", () => {
  it("downgrades an unbacked completion claim to the honest notice — a reply must not lie", async () => {
    const run = buildRun({ output: KO_CLAIM, toolsUsed: [] });
    const reply = await run({
      messages: [{ content: KO_QUERY, role: "user" }],
      providerId: "log",
      scope: "direct",
      source: "42"
    });
    expect(reply).not.toContain("등록했습니다");
    expect(reply).toBe(unbackedActionNoticeFor(KO_QUERY));
  });

  it("passes a BACKED completion claim through unchanged (a real actuator ran)", async () => {
    const run = buildRun({ output: KO_CLAIM, toolsUsed: ["calendar.create"] });
    const reply = await run({
      messages: [{ content: KO_QUERY, role: "user" }],
      providerId: "log",
      scope: "direct",
      source: "42"
    });
    expect(reply).toBe(KO_CLAIM);
  });

  it("passes an answer with no completion claim through unchanged (a plain question)", async () => {
    const answer = "아직 예약되지 않았어요.";
    const run = buildRun({ output: answer, toolsUsed: [] });
    const reply = await run({
      messages: [{ content: "치과 예약 잡혔어?", role: "user" }],
      providerId: "log",
      scope: "direct",
      source: "42"
    });
    expect(reply).toBe(answer);
  });
});

describe("createInboundAgentRun channel pairing gate", () => {
  function buildGated(dir: string, agentCalls: string[], extraEnv: Record<string, string> = {}) {
    const registry = new MessagingProviderRegistry([
      new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
    ]);
    const agentRuntime = {
      run: async () => {
        agentCalls.push("run");
        return { groundingSources: [{ source: "/x/notes/a.md", text: "ok" }], response: { output: "answer [from a.md]." } };
      }
    };
    const env = {
      MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
      MUSE_CHANNEL_OWNERS_FILE: join(dir, "channel-owners.json"),
      MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
      MUSE_PENDING_APPROVALS_FILE: join(dir, "pending.json"),
      ...extraEnv
    };
    return createInboundAgentRun({ agentRuntime, env, model: "default", registry });
  }

  it("adopts the FIRST chat as owner and answers it normally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-pairing-"));
    const agentCalls: string[] = [];
    const run = buildGated(dir, agentCalls);
    // NOT a casual greeting — this probes pairing, not the S1 fast-path.
    const reply = await run({ messages: [{ content: "test message", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(agentCalls).toEqual(["run"]);
    expect(reply).toContain("answer");
  });

  it("refuses a SECOND chat deterministically — the agent never runs and no personal data flows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-pairing-"));
    const agentCalls: string[] = [];
    const run = buildGated(dir, agentCalls);
    await run({ messages: [{ content: "test message", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });

    const strangerReply = await run({ messages: [{ content: "what are the owner's secrets?", role: "user" }], providerId: "log", scope: "direct", source: "stranger-9" });
    expect(agentCalls).toEqual(["run"]);
    expect(strangerReply).not.toContain("answer");
    expect(strangerReply.length).toBeGreaterThan(0);

    const ownerAgain = await run({ messages: [{ content: "still me", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(ownerAgain).toContain("answer");
    expect(agentCalls).toEqual(["run", "run"]);
  });

  it("MUSE_CHANNEL_ALLOWED_CHATS grants an extra chat beyond the owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-pairing-"));
    const agentCalls: string[] = [];
    const run = buildGated(dir, agentCalls, { MUSE_CHANNEL_ALLOWED_CHATS: "log:family-2" });
    await run({ messages: [{ content: "test message", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    const familyReply = await run({ messages: [{ content: "another message", role: "user" }], providerId: "log", scope: "direct", source: "family-2" });
    expect(familyReply).toContain("answer");
    expect(agentCalls).toEqual(["run", "run"]);
  });
});

// Conversation-scope capability profiles (P7-3, the sequel to TOFU pairing):
// a group/shared chat must never (a) adopt itself as the TOFU owner, (b) get
// the owner's personal-memory scope, or (c) reach a risky tool via draft +
// in-chat "yes" — even when MUSE_CHANNEL_ALLOWED_CHATS explicitly allows it.
describe("createInboundAgentRun conversation-scope: shared (group) chat safety", () => {
  function buildScoped(
    dir: string,
    agentCalls: { readonly metadata: { readonly userId: string } }[],
    extraEnv: Record<string, string> = {}
  ) {
    const registry = new MessagingProviderRegistry([
      new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
    ]);
    const agentRuntime = {
      run: async (input: { readonly metadata: { readonly userId: string } }) => {
        agentCalls.push({ metadata: input.metadata });
        return { groundingSources: [{ source: "/x/notes/a.md", text: "ok" }], response: { output: "answer [from a.md]." } };
      }
    };
    const ownersFile = join(dir, "channel-owners.json");
    const env = {
      MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
      MUSE_CHANNEL_OWNERS_FILE: ownersFile,
      MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
      MUSE_PENDING_APPROVALS_FILE: join(dir, "pending.json"),
      ...extraEnv
    };
    return { ownersFile, run: createInboundAgentRun({ agentRuntime, env, model: "default", registry }) };
  }

  async function ownerFileHasNoOwner(ownersFile: string, providerId: string): Promise<boolean> {
    const fs = await import("node:fs/promises");
    try {
      const parsed = JSON.parse(await fs.readFile(ownersFile, "utf8")) as { owners?: Record<string, string> };
      return parsed.owners?.[providerId] === undefined;
    } catch {
      return true; // file never created — also proves no adoption happened
    }
  }

  it("group flag OFF (default): a shared-scope chat is refused and NEVER adopted as owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-scope-"));
    const agentCalls: { readonly metadata: { readonly userId: string } }[] = [];
    const { run, ownersFile } = buildScoped(dir, agentCalls);
    const reply = await run({ messages: [{ content: "hi everyone", role: "user" }], providerId: "log", scope: "shared", source: "-100999" });
    expect(agentCalls).toHaveLength(0);
    expect(reply).not.toContain("answer");
    expect(reply.length).toBeGreaterThan(0);
    expect(await ownerFileHasNoOwner(ownersFile, "log")).toBe(true);
  });

  it("group flag ON but the chat is NOT in MUSE_CHANNEL_ALLOWED_CHATS: still refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-scope-"));
    const agentCalls: { readonly metadata: { readonly userId: string } }[] = [];
    const { run } = buildScoped(dir, agentCalls, { MUSE_CHANNEL_GROUP_ENABLED: "true" });
    const reply = await run({ messages: [{ content: "hi everyone", role: "user" }], providerId: "log", scope: "shared", source: "-100999" });
    expect(agentCalls).toHaveLength(0);
    expect(reply).not.toContain("answer");
  });

  it("group flag ON + chat allowed: the agent runs, but with a SHARED-scoped userId — owner still never adopted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-scope-"));
    const agentCalls: { readonly metadata: { readonly userId: string } }[] = [];
    const { run, ownersFile } = buildScoped(dir, agentCalls, {
      MUSE_CHANNEL_ALLOWED_CHATS: "log:-100999",
      MUSE_CHANNEL_GROUP_ENABLED: "true"
    });
    const reply = await run({ messages: [{ content: "hi everyone", role: "user" }], providerId: "log", scope: "shared", source: "-100999" });
    expect(reply).toContain("answer");
    expect(agentCalls).toHaveLength(1);
    // Personal facts must never inject into a group turn, and group chatter
    // must never pollute the owner's user model — a distinct memory scope.
    expect(agentCalls[0]?.metadata.userId).toBe("log:shared:-100999");
    expect(await ownerFileHasNoOwner(ownersFile, "log")).toBe(true);
  });

  it("a refused risky tool in shared scope leaves NO pending-approval entry (the group 'yes' re-run path is impossible), but is still logged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-scope-"));
    const registry = new MessagingProviderRegistry([
      new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
    ]);
    const agentRuntime = {
      run: async (input: {
        readonly toolApprovalGate: (i: {
          readonly toolCall: { readonly name: string; readonly arguments?: Record<string, unknown> };
          readonly risk: "read" | "write" | "execute";
          readonly runId: string;
        }) => Promise<unknown>;
      }) => {
        await input.toolApprovalGate({ risk: "execute", runId: "r1", toolCall: { arguments: { url: "http://x.test/book" }, name: "web_action" } });
        return { response: { output: "" } };
      }
    };
    const pendingFile = join(dir, "pending.json");
    const actionLogFile = join(dir, "action-log.json");
    const env = {
      MUSE_ACTION_LOG_FILE: actionLogFile,
      MUSE_CHANNEL_ALLOWED_CHATS: "log:-100999",
      MUSE_CHANNEL_GROUP_ENABLED: "true",
      MUSE_CHANNEL_OWNERS_FILE: join(dir, "channel-owners.json"),
      MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
      MUSE_PENDING_APPROVALS_FILE: pendingFile
    };
    const run = createInboundAgentRun({ agentRuntime, env, model: "default", registry });
    await run({ messages: [{ content: "book a flight", role: "user" }], providerId: "log", scope: "shared", source: "-100999" });

    const fs = await import("node:fs/promises");
    let pendingCount = 0; // file never created also counts as zero — proves no pending entry
    try {
      const parsed = JSON.parse(await fs.readFile(pendingFile, "utf8")) as { pending?: unknown[] };
      pendingCount = parsed.pending?.length ?? 0;
    } catch {
      // pendingFile absent — pendingCount stays 0
    }
    expect(pendingCount).toBe(0);

    const actionLog = JSON.parse(await fs.readFile(actionLogFile, "utf8")) as { entries?: readonly { readonly result: string }[] };
    expect(actionLog.entries?.some((entry) => entry.result === "refused")).toBe(true);
  });

  it("a refused risky tool in DIRECT scope still records a pending entry as today (regression)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-scope-"));
    const registry = new MessagingProviderRegistry([
      new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
    ]);
    const agentRuntime = {
      run: async (input: {
        readonly toolApprovalGate: (i: {
          readonly toolCall: { readonly name: string; readonly arguments?: Record<string, unknown> };
          readonly risk: "read" | "write" | "execute";
          readonly runId: string;
        }) => Promise<unknown>;
      }) => {
        await input.toolApprovalGate({ risk: "execute", runId: "r1", toolCall: { arguments: { url: "http://x.test/book" }, name: "web_action" } });
        return { response: { output: "" } };
      }
    };
    const pendingFile = join(dir, "pending.json");
    const env = {
      MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
      MUSE_CHANNEL_OWNERS_FILE: join(dir, "channel-owners.json"),
      MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
      MUSE_PENDING_APPROVALS_FILE: pendingFile
    };
    const run = createInboundAgentRun({ agentRuntime, env, model: "default", registry });
    await run({ messages: [{ content: "book a flight", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });

    const fs = await import("node:fs/promises");
    const parsed = JSON.parse(await fs.readFile(pendingFile, "utf8")) as { pending?: readonly unknown[] };
    expect(parsed.pending).toHaveLength(1);
  });

  it("a shared-scope \"yes\" does NOT resolve a pending approval (approval-reply handling is skipped for group chats)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-scope-"));
    const agentCalls: { readonly metadata: { readonly userId: string } }[] = [];
    const pendingFile = join(dir, "pending.json");
    await recordPendingApproval(pendingFile, {
      arguments: { url: "http://x.test/book" },
      createdAt: NOW().toISOString(),
      draft: "POST http://x.test/book",
      // `handleInboundApprovalReply` uses the REAL wall clock (no `now`
      // injected by inbound-agent-run.ts today), not the fixture NOW() —
      // far-future so the test doesn't depend on when it actually runs.
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      id: "pending-1",
      providerId: "log",
      risk: "execute",
      source: "-100999",
      tool: "web_action"
    });
    const { run } = buildScoped(dir, agentCalls, {
      MUSE_CHANNEL_ALLOWED_CHATS: "log:-100999",
      MUSE_CHANNEL_GROUP_ENABLED: "true",
      MUSE_PENDING_APPROVALS_FILE: pendingFile
    });

    const reply = await run({ messages: [{ content: "yes", role: "user" }], providerId: "log", scope: "shared", source: "-100999" });

    // The "yes" fell through to the NORMAL agent turn (not an approval ack) —
    // proof the pending approval was never even consulted for this scope.
    expect(agentCalls).toHaveLength(1);
    expect(reply).toContain("answer");
    expect(reply.toLowerCase()).not.toContain("muse approvals approve");
  });
});

// Channel-veto reply ("그만"/"stop"): the one-touch off-switch for
// proactivity. Runs AFTER the pairing + approval-reply gates, BEFORE the
// casual fast-path — a match records a vetoed trust-ledger entry and the
// agent never runs; anything else falls through untouched.
describe("createInboundAgentRun channel-veto reply", () => {
  function buildVeto(dir: string, agentCalls: string[], extraEnv: Record<string, string> = {}) {
    const registry = new MessagingProviderRegistry([
      new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
    ]);
    const agentRuntime = {
      run: async () => {
        agentCalls.push("run");
        return { groundingSources: [{ source: "/x/notes/a.md", text: "ok" }], response: { output: "answer [from a.md]." } };
      }
    };
    const env = {
      MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
      MUSE_CHANNEL_OWNERS_FILE: join(dir, "channel-owners.json"),
      MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
      MUSE_LAST_PROACTIVE_FILE: join(dir, "last-delivery.json"),
      MUSE_PENDING_APPROVALS_FILE: join(dir, "pending.json"),
      MUSE_PROACTIVE_TRUST_FILE: join(dir, "trust.json"),
      ...extraEnv
    };
    return { env, run: createInboundAgentRun({ agentRuntime, env, model: "default", registry }) };
  }

  it("a matching veto phrase with a recent delivery on record silences it, and the agent never runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-veto-"));
    const agentCalls: string[] = [];
    const { env, run } = buildVeto(dir, agentCalls);
    await appendLastProactiveDelivery(env.MUSE_LAST_PROACTIVE_FILE, {
      at: NOW(),
      outcome: "delivered",
      sourceKey: "pattern-firing:pat-1",
      title: "your Tuesday journal habit"
    });
    const reply = await run({ messages: [{ content: "그만", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).toContain("your Tuesday journal habit");
    expect(agentCalls).toHaveLength(0);
    const avoided = avoidedSourceKeys(await readTrustLedger(env.MUSE_PROACTIVE_TRUST_FILE));
    expect(avoided.has("pattern-firing:pat-1")).toBe(true);
  });

  it("no delivery on record → falls through to the normal agent turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-veto-"));
    const agentCalls: string[] = [];
    const { run } = buildVeto(dir, agentCalls);
    const reply = await run({ messages: [{ content: "그만", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(agentCalls).toHaveLength(1);
    expect(reply).toContain("answer");
  });

  it("shared (group) scope: a veto phrase never silences anything, even with a fresh delivery on record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-veto-"));
    const agentCalls: string[] = [];
    const { env, run } = buildVeto(dir, agentCalls, { MUSE_CHANNEL_ALLOWED_CHATS: "log:-100999", MUSE_CHANNEL_GROUP_ENABLED: "true" });
    await appendLastProactiveDelivery(env.MUSE_LAST_PROACTIVE_FILE, {
      at: NOW(), outcome: "delivered", sourceKey: "pattern-firing:pat-1"
    });
    const reply = await run({ messages: [{ content: "그만", role: "user" }], providerId: "log", scope: "shared", source: "-100999" });
    expect(agentCalls).toHaveLength(1); // fell through to the agent, not the veto handler
    expect(reply).toContain("answer");
    const avoided = avoidedSourceKeys(await readTrustLedger(env.MUSE_PROACTIVE_TRUST_FILE));
    expect(avoided.size).toBe(0); // nothing recorded
  });

  it("gate ordering: an unpaired stranger's veto phrase still gets the pairing refusal, not a veto confirmation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-veto-"));
    const agentCalls: string[] = [];
    const { env, run } = buildVeto(dir, agentCalls);
    await run({ messages: [{ content: "what is my rent?", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" }); // adopts owner
    await appendLastProactiveDelivery(env.MUSE_LAST_PROACTIVE_FILE, {
      at: NOW(), outcome: "delivered", sourceKey: "pattern-firing:pat-1"
    });
    const strangerReply = await run({ messages: [{ content: "그만", role: "user" }], providerId: "log", scope: "direct", source: "stranger-9" });
    expect(strangerReply).toBe("This bot is a private personal assistant and only talks to its paired owner.");
    const avoided = avoidedSourceKeys(await readTrustLedger(env.MUSE_PROACTIVE_TRUST_FILE));
    expect(avoided.size).toBe(0); // the stranger's "그만" never reached the veto handler
  });

  it("gate ordering: a pure approval word with a pending approval resolves as the approval ack, never a veto", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-veto-"));
    const agentCalls: string[] = [];
    const { env, run } = buildVeto(dir, agentCalls);
    await recordPendingApproval(env.MUSE_PENDING_APPROVALS_FILE, {
      arguments: { url: "http://x.test/book" },
      createdAt: NOW().toISOString(),
      draft: "POST http://x.test/book",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      id: "pending-1",
      providerId: "log",
      risk: "execute",
      source: "owner-1",
      tool: "web_action"
    });
    await appendLastProactiveDelivery(env.MUSE_LAST_PROACTIVE_FILE, {
      at: NOW(), outcome: "delivered", sourceKey: "pattern-firing:pat-1"
    });
    const reply = await run({ messages: [{ content: "ok", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).toContain("muse approvals approve pending-1");
    expect(agentCalls).toHaveLength(0);
    const avoided = avoidedSourceKeys(await readTrustLedger(env.MUSE_PROACTIVE_TRUST_FILE));
    expect(avoided.size).toBe(0); // "ok" is not a veto phrase — approval handling took it first
  });

  it("a matched EN veto phrase returns the veto confirmation, not a casual reply or the full agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-veto-"));
    const agentCalls: string[] = [];
    const { env, run } = buildVeto(dir, agentCalls);
    await appendLastProactiveDelivery(env.MUSE_LAST_PROACTIVE_FILE, {
      at: NOW(), outcome: "delivered", sourceKey: "pattern-firing:pat-1", title: "journal habit"
    });
    const reply = await run({ messages: [{ content: "stop", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).not.toBe(casualResponseFor("greeting"));
    expect(reply).toContain("journal habit");
    expect(agentCalls).toHaveLength(0);
  });
});

// Deterministic casual fast-path (S1, parity with `muse ask`): a bare
// greeting/thanks/farewell answers instantly with the shared canned text and
// never touches the agent run or the grounding gate — but only AFTER the
// pairing and approval-reply gates have had their say.
describe("createInboundAgentRun casual fast-path", () => {
  function buildCasual(dir: string, agentCalls: string[], extraEnv: Record<string, string> = {}) {
    const registry = new MessagingProviderRegistry([
      new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
    ]);
    const agentRuntime = {
      run: async () => {
        agentCalls.push("run");
        return { groundingSources: [{ source: "/x/notes/a.md", text: "ok" }], response: { output: "answer [from a.md]." } };
      }
    };
    const env = {
      MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
      MUSE_CHANNEL_OWNERS_FILE: join(dir, "channel-owners.json"),
      MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
      MUSE_PENDING_APPROVALS_FILE: join(dir, "pending.json"),
      ...extraEnv
    };
    return createInboundAgentRun({ agentRuntime, env, model: "default", registry });
  }

  it("a casual greeting answers with the canned reply — the agent never runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-casual-"));
    const agentCalls: string[] = [];
    const run = buildCasual(dir, agentCalls);
    const reply = await run({ messages: [{ content: "hi", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).toBe(casualResponseFor("greeting"));
    expect(agentCalls).toHaveLength(0);
  });

  it("a Korean casual greeting/thanks/farewell answers in Korean, not the English canned reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-casual-ko-"));
    const agentCalls: string[] = [];
    const run = buildCasual(dir, agentCalls);
    for (const [content, kind] of [["안녕~", "greeting"], ["고마워", "thanks"], ["잘자", "farewell"]] as const) {
      const reply = await run({ messages: [{ content, role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
      expect(reply, content).toBe(casualResponseFor(kind, true));
      expect(reply, content).not.toBe(casualResponseFor(kind));
      expect(reply, content).toMatch(/[가-힣]/u);
    }
    expect(agentCalls).toHaveLength(0);
  });

  it("a real question still runs the full agent exactly as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-casual-"));
    const agentCalls: string[] = [];
    const run = buildCasual(dir, agentCalls);
    const reply = await run({ messages: [{ content: "what is my rent?", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(agentCalls).toHaveLength(1);
    expect(reply).toContain("answer");
  });

  it("gate ordering: an unpaired stranger sending a casual greeting still gets the pairing refusal, not the canned reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-casual-"));
    const agentCalls: string[] = [];
    const run = buildCasual(dir, agentCalls);
    // First chat adopts as owner.
    await run({ messages: [{ content: "what is my rent?", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    const strangerReply = await run({ messages: [{ content: "hi", role: "user" }], providerId: "log", scope: "direct", source: "stranger-9" });
    expect(strangerReply).toBe("This bot is a private personal assistant and only talks to its paired owner.");
    expect(strangerReply).not.toBe(casualResponseFor("greeting"));
    expect(agentCalls).toHaveLength(1); // only the owner's turn ran
  });

  it("gate ordering: a pure approval word with a pending approval resolves as the approval ack, never the casual path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-casual-"));
    const agentCalls: string[] = [];
    const pendingFile = join(dir, "pending.json");
    await recordPendingApproval(pendingFile, {
      arguments: { url: "http://x.test/book" },
      createdAt: NOW().toISOString(),
      draft: "POST http://x.test/book",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      id: "pending-1",
      providerId: "log",
      risk: "execute",
      source: "owner-1",
      tool: "web_action"
    });
    const run = buildCasual(dir, agentCalls, { MUSE_PENDING_APPROVALS_FILE: pendingFile });
    const reply = await run({ messages: [{ content: "ok", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).toContain("muse approvals approve pending-1");
    expect(agentCalls).toHaveLength(0);
  });

  it("gate ordering: a casual greeting with an unrelated pending approval still answers casually, leaving the approval untouched — proof approval-reply handling runs first and correctly declines a non-approval text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-casual-"));
    const agentCalls: string[] = [];
    const pendingFile = join(dir, "pending.json");
    await recordPendingApproval(pendingFile, {
      arguments: { url: "http://x.test/book" },
      createdAt: NOW().toISOString(),
      draft: "POST http://x.test/book",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      id: "pending-1",
      providerId: "log",
      risk: "execute",
      source: "owner-1",
      tool: "web_action"
    });
    const run = buildCasual(dir, agentCalls, { MUSE_PENDING_APPROVALS_FILE: pendingFile });
    const reply = await run({ messages: [{ content: "hi", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).toBe(casualResponseFor("greeting"));
    expect(agentCalls).toHaveLength(0);

    const fs = await import("node:fs/promises");
    const parsed = JSON.parse(await fs.readFile(pendingFile, "utf8")) as { pending?: readonly { readonly id: string }[] };
    expect(parsed.pending?.some((entry) => entry.id === "pending-1")).toBe(true);
  });
});

// Delegation ack (S2, "the assistant rhythm"): a non-casual, non-approval,
// paired-chat request gets an early second-channel acknowledgment BEFORE the
// (possibly slow) agent run — sequential, fail-open, and gated to fire ONLY
// on the genuine delegation path (every earlier gate still wins first).
describe("createInboundAgentRun delegation ack (S2)", () => {
  function buildAck(
    dir: string,
    opts: {
      readonly composeAck?: (input: { readonly latestUserText: string }) => Promise<string | null>;
      readonly extraEnv?: Record<string, string>;
    } = {}
  ) {
    const calls: string[] = [];
    const registry = new MessagingProviderRegistry([
      new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
    ]);
    const agentRuntime = {
      run: async () => {
        calls.push("run");
        return { groundingSources: [{ source: "/x/notes/a.md", text: "ok" }], response: { output: "answer [from a.md]." } };
      }
    };
    const env = {
      MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
      MUSE_CHANNEL_OWNERS_FILE: join(dir, "channel-owners.json"),
      MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
      MUSE_PENDING_APPROVALS_FILE: join(dir, "pending.json"),
      ...opts.extraEnv
    };
    const composeAck = opts.composeAck
      ? async (input: { readonly latestUserText: string }) => {
          calls.push(`composeAck:${input.latestUserText}`);
          return opts.composeAck!(input);
        }
      : undefined;
    const run = createInboundAgentRun({
      agentRuntime,
      ...(composeAck ? { composeAck } : {}),
      env,
      model: "default",
      registry
    });
    return { calls, run };
  }

  it("ordering: composeAck is called, then notify with its result, then agentRuntime.run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-ack-"));
    const { calls, run } = buildAck(dir, { composeAck: async () => "on it — I'll report back" });
    const notified: string[] = [];
    const reply = await run({
      messages: [{ content: "book a flight for me", role: "user" }],
      notify: async (text) => {
        calls.push(`notify:${text}`);
        notified.push(text);
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(calls).toEqual([
      "composeAck:book a flight for me",
      "notify:on it — I'll report back",
      "run"
    ]);
    expect(notified).toEqual(["on it — I'll report back"]);
    expect(reply).toContain("answer");
  });

  it("composeAck throwing → no notify, run still proceeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-ack-"));
    const { calls, run } = buildAck(dir, {
      composeAck: async () => {
        throw new Error("model unavailable");
      }
    });
    let notifyCalls = 0;
    const reply = await run({
      messages: [{ content: "book a flight", role: "user" }],
      notify: async () => {
        notifyCalls += 1;
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(notifyCalls).toBe(0);
    expect(calls).toEqual(["composeAck:book a flight", "run"]);
    expect(reply).toContain("answer");
  });

  it("composeAck returning null → no notify, run still proceeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-ack-"));
    const { calls, run } = buildAck(dir, { composeAck: async () => null });
    let notifyCalls = 0;
    const reply = await run({
      messages: [{ content: "book a flight", role: "user" }],
      notify: async () => {
        notifyCalls += 1;
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(notifyCalls).toBe(0);
    expect(calls).toEqual(["composeAck:book a flight", "run"]);
    expect(reply).toContain("answer");
  });

  it("MUSE_CHANNEL_ACK=false → composeAck is never invoked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-ack-"));
    const { calls, run } = buildAck(dir, {
      composeAck: async () => "should never run",
      extraEnv: { MUSE_CHANNEL_ACK: "false" }
    });
    const reply = await run({
      messages: [{ content: "book a flight", role: "user" }],
      notify: async () => {
        throw new Error("notify should never be called");
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(calls).toEqual(["run"]);
    expect(reply).toContain("answer");
  });

  it("MUSE_CHANNEL_ACK=0 (parseBoolean's other falsy spelling) → composeAck is never invoked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-ack-"));
    const { calls, run } = buildAck(dir, {
      composeAck: async () => "should never run",
      extraEnv: { MUSE_CHANNEL_ACK: "0" }
    });
    const reply = await run({
      messages: [{ content: "book a flight", role: "user" }],
      notify: async () => {
        throw new Error("notify should never be called");
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(calls).toEqual(["run"]);
    expect(reply).toContain("answer");
  });

  it("unpaired chat → composeAck never invoked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-ack-"));
    const { calls, run } = buildAck(dir, { composeAck: async () => "should never run" });
    // First chat adopts as owner (this turn's ack fires as expected).
    await run({
      messages: [{ content: "book a flight", role: "user" }],
      notify: async (text) => calls.push(`notify:${text}`),
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });
    calls.length = 0;

    const strangerReply = await run({
      messages: [{ content: "book a flight", role: "user" }],
      notify: async () => {
        throw new Error("notify should never be called for a stranger");
      },
      providerId: "log",
      scope: "direct",
      source: "stranger-9"
    });

    expect(strangerReply).toBe("This bot is a private personal assistant and only talks to its paired owner.");
    expect(calls).toEqual([]);
  });

  it("approval-reply 'ok' path → composeAck never invoked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-ack-"));
    const pendingFile = join(dir, "pending.json");
    await recordPendingApproval(pendingFile, {
      arguments: { url: "http://x.test/book" },
      createdAt: NOW().toISOString(),
      draft: "POST http://x.test/book",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      id: "pending-1",
      providerId: "log",
      risk: "execute",
      source: "owner-1",
      tool: "web_action"
    });
    const { calls, run } = buildAck(dir, {
      composeAck: async () => "should never run",
      extraEnv: { MUSE_PENDING_APPROVALS_FILE: pendingFile }
    });
    const reply = await run({
      messages: [{ content: "ok", role: "user" }],
      notify: async () => {
        throw new Error("notify should never be called");
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(reply).toContain("muse approvals approve pending-1");
    expect(calls).toEqual([]);
  });

  it("casual 'hi' → composeAck never invoked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-ack-"));
    const { calls, run } = buildAck(dir, { composeAck: async () => "should never run" });
    const reply = await run({
      messages: [{ content: "hi", role: "user" }],
      notify: async () => {
        throw new Error("notify should never be called");
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(reply).toBe(casualResponseFor("greeting"));
    expect(calls).toEqual([]);
  });
});
