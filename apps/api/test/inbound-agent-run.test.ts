import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { casualResponseFor, UNGROUNDABLE_ANSWER_NOTICE, unbackedActionNoticeFor } from "@muse/agent-core";
import type { UserMemory, UserMemoryStore } from "@muse/memory";
import { LogMessagingProvider, MessagingProviderRegistry, recordPendingApproval } from "@muse/messaging";
import { appendLastProactiveDelivery, avoidedSourceKeys, readFollowups, readTrustLedger, writeFollowups, type PersistedFollowup } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { createInboundAgentRun } from "../src/inbound-agent-run.js";

// The channel reply surface (Telegram et al.) answers with the FULL agent, so
// its output must pass the SAME deterministic grounding + citation gate the
// API /chat and CLI chat surfaces apply: a citation naming a source the run
// never produced is dropped BY CODE before the reply leaves for the channel,
// and a properly grounded answer passes through byte-identical.

// Relative, not pinned: handleInboundVetoReply runs on the real wall clock
// inside createInboundAgentRun, so a pinned date turns these into time-bomb
// tests that go red the day after they were written.
const NOW = () => new Date(Date.now() - 60 * 60 * 1000);

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

// Conversational fast-path (S3, completing the assistant rhythm): a message
// classifyChannelIntent reads as pure smalltalk gets ONE single-inference
// reply — no ack, no full agent run — but stays behind every earlier gate
// (pairing/approval/veto/casual) and is TRIPLE fail-open (flag off / no
// composer / classifier says delegation / composer returns null all fall
// through unchanged to the existing ack + full-run path).
describe("createInboundAgentRun chat fast-path (S3)", () => {
  function buildChat(
    dir: string,
    opts: {
      readonly composeChatReply?: (input: {
        readonly latestUserText: string;
        readonly thread: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
        readonly personaSnapshot?: readonly { readonly source: string; readonly text: string }[];
      }) => Promise<string | null>;
      readonly composeAck?: (input: { readonly latestUserText: string }) => Promise<string | null>;
      readonly extraEnv?: Record<string, string>;
      readonly userMemoryStore?: UserMemoryStore;
    } = {}
  ) {
    const calls: string[] = [];
    const personaSnapshots: (readonly { readonly source: string; readonly text: string }[] | undefined)[] = [];
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
    const composeChatReply = opts.composeChatReply
      ? async (input: {
          readonly latestUserText: string;
          readonly thread: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
          readonly personaSnapshot?: readonly { readonly source: string; readonly text: string }[];
        }) => {
          calls.push(`composeChatReply:${input.latestUserText}`);
          personaSnapshots.push(input.personaSnapshot);
          return opts.composeChatReply!(input);
        }
      : undefined;
    const composeAck = opts.composeAck
      ? async (input: { readonly latestUserText: string }) => {
          calls.push(`composeAck:${input.latestUserText}`);
          return opts.composeAck!(input);
        }
      : undefined;
    const run = createInboundAgentRun({
      agentRuntime,
      ...(composeAck ? { composeAck } : {}),
      ...(composeChatReply ? { composeChatReply } : {}),
      env,
      model: "default",
      registry,
      ...(opts.userMemoryStore ? { userMemoryStore: opts.userMemoryStore } : {})
    });
    return { calls, personaSnapshots, run };
  }

  const CHAT_TEXT = "오늘 좀 피곤하네 ㅋㅋ";
  const DELEGATION_TEXT = "내일 오후 3시에 치과 예약 잡아줘";

  it("a chat-classified message: composeChatReply is called and its (gated) reply is returned — no ack, no agentRuntime.run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { calls, run } = buildChat(dir, {
      composeAck: async () => "should never run",
      composeChatReply: async () => "아이고 피곤하겠다! 얼른 쉬어~"
    });
    const reply = await run({
      messages: [{ content: CHAT_TEXT, role: "user" }],
      notify: async () => {
        throw new Error("notify should never be called for the chat fast-path");
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(reply).toBe("아이고 피곤하겠다! 얼른 쉬어~");
    expect(calls).toEqual([`composeChatReply:${CHAT_TEXT}`]);
  });

  it("a delegation-classified message: composeChatReply is NEVER invoked, and the normal ack + run path proceeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { calls, run } = buildChat(dir, {
      composeAck: async () => "on it — I'll report back",
      composeChatReply: async () => "should never run"
    });
    const reply = await run({
      messages: [{ content: DELEGATION_TEXT, role: "user" }],
      notify: async (text) => {
        calls.push(`notify:${text}`);
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(calls).toEqual([`composeAck:${DELEGATION_TEXT}`, "notify:on it — I'll report back", "run"]);
    expect(reply).toContain("answer");
  });

  it("composeChatReply returning null (fail-open): falls through to the ack + full run, NOT a chat reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { calls, run } = buildChat(dir, {
      composeAck: async () => "on it — I'll report back",
      composeChatReply: async () => null
    });
    const reply = await run({
      messages: [{ content: CHAT_TEXT, role: "user" }],
      notify: async (text) => {
        calls.push(`notify:${text}`);
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(calls).toEqual([`composeChatReply:${CHAT_TEXT}`, `composeAck:${CHAT_TEXT}`, "notify:on it — I'll report back", "run"]);
    expect(reply).toContain("answer");
  });

  it("composeChatReply throwing (fail-open): falls through to the ack + full run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { calls, run } = buildChat(dir, {
      composeAck: async () => "on it — I'll report back",
      composeChatReply: async () => {
        throw new Error("model unavailable");
      }
    });
    const reply = await run({
      messages: [{ content: CHAT_TEXT, role: "user" }],
      notify: async (text) => {
        calls.push(`notify:${text}`);
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(calls).toEqual([`composeChatReply:${CHAT_TEXT}`, `composeAck:${CHAT_TEXT}`, "notify:on it — I'll report back", "run"]);
    expect(reply).toContain("answer");
  });

  it("MUSE_CHANNEL_CHAT=false → composeChatReply is never invoked, even for a chat-classified message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { calls, run } = buildChat(dir, {
      composeAck: async () => "on it — I'll report back",
      composeChatReply: async () => "should never run",
      extraEnv: { MUSE_CHANNEL_CHAT: "false" }
    });
    const reply = await run({
      messages: [{ content: CHAT_TEXT, role: "user" }],
      notify: async (text) => {
        calls.push(`notify:${text}`);
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(calls).toEqual([`composeAck:${CHAT_TEXT}`, "notify:on it — I'll report back", "run"]);
    expect(reply).toContain("answer");
  });

  it("no composeChatReply provided → the flag being on is harmless, ack + run proceeds normally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { calls, run } = buildChat(dir, { composeAck: async () => "on it — I'll report back" });
    const reply = await run({
      messages: [{ content: CHAT_TEXT, role: "user" }],
      notify: async (text) => {
        calls.push(`notify:${text}`);
      },
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(calls).toEqual([`composeAck:${CHAT_TEXT}`, "notify:on it — I'll report back", "run"]);
    expect(reply).toContain("answer");
  });

  it("the chat reply runs through the SAME gate as the full path — a CITATION-SHAPED string is stripped (citation-stripping backstop, not general fabrication defense)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { run } = buildChat(dir, {
      composeChatReply: async () => "그건 900,000원이야 [from notes/rent.md]."
    });
    const reply = await run({
      messages: [{ content: CHAT_TEXT, role: "user" }],
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(reply).not.toContain("900,000");
  });

  it("BOUNDARY: with no userMemoryStore configured (no snapshot → empty evidence), an UNCITED invented fact passes through unchanged (the real defense here is composeChatReply's own no-facts prompt + PASS sentinel + the conservative classifier, NOT this gate)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { run } = buildChat(dir, {
      // No citation marker at all — the gate has nothing to check an
      // uncited claim against with an empty evidence list, so it cannot
      // catch this even if it were false. That's WHY the composer's
      // system prompt (createComposeChatReply) is what actually forbids
      // inventing facts on this path, not this gate.
      composeChatReply: async () => "그건 900,000원이야."
    });
    const reply = await run({
      messages: [{ content: CHAT_TEXT, role: "user" }],
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(reply).toBe("그건 900,000원이야.");
  });

  function fakePersonaStore(byUserId: Readonly<Record<string, UserMemory>>): UserMemoryStore {
    return {
      deleteByUserId: async () => true,
      findByUserId: async (userId: string) => byUserId[userId],
      upsertFact: async (userId: string) => {
        throw new Error(`unexpected upsertFact(${userId})`);
      },
      upsertPreference: async (userId: string) => {
        throw new Error(`unexpected upsertPreference(${userId})`);
      }
    };
  }

  const OWNER_1_MEMORY: UserMemory = {
    facts: { hobby: "climbing", name: "진안" },
    preferences: {},
    recentTopics: [],
    updatedAt: NOW(),
    userId: "log:owner-1"
  };

  it("BOUNDARY STILL HOLDS with a real persona snapshot: an UNCITED invented fact NOT in the snapshot still passes through unchanged — enforceAnswerCitations only ever inspects CITED sentences, so adding evidence closes the citation-referent gap, not the general free-text one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { run } = buildChat(dir, {
      composeChatReply: async () => "그건 900,000원이야.", // rent is nowhere in the snapshot, and uncited
      userMemoryStore: fakePersonaStore({ "log:owner-1": OWNER_1_MEMORY })
    });
    const reply = await run({
      messages: [{ content: CHAT_TEXT, role: "user" }],
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(reply).toBe("그건 900,000원이야.");
  });

  it("the chat fast-path loads the owner-scope persona snapshot and passes the SAME lines to composeChatReply and to the grounding gate's evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { personaSnapshots, run } = buildChat(dir, {
      // Cite a snapshot source directly — this only proves the gate's
      // citation machinery now has a real referent to resolve against; the
      // production system prompt itself forbids citing at all. One sentence
      // (period, not "!", so `enforceAnswerCitations`' sentence splitter
      // keeps the citation attached to the claim it grounds).
      composeChatReply: async () => "등산 좋아하는구나 [from persona:fact:hobby].",
      userMemoryStore: fakePersonaStore({ "log:owner-1": OWNER_1_MEMORY })
    });
    const reply = await run({
      messages: [{ content: CHAT_TEXT, role: "user" }],
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(personaSnapshots[0]).toEqual(
      expect.arrayContaining([{ source: "persona:fact:hobby", text: "hobby: climbing" }])
    );
    // The citation resolves against the loaded snapshot, so the WHOLE
    // sentence (not just the marker) survives unchanged.
    expect(reply).toContain("등산 좋아하는구나");
  });

  it("a citation naming something OUTSIDE the persona snapshot is still stripped by the gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { run } = buildChat(dir, {
      composeChatReply: async () => "그건 900,000원이야 [from persona:fact:rent].",
      userMemoryStore: fakePersonaStore({ "log:owner-1": OWNER_1_MEMORY })
    });
    const reply = await run({
      messages: [{ content: CHAT_TEXT, role: "user" }],
      providerId: "log",
      scope: "direct",
      source: "owner-1"
    });

    expect(reply).not.toContain("900,000");
  });

  it("scope discipline at the call site: a shared/group chat NEVER gets a persona snapshot even when a userMemoryStore is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    let queried = false;
    const groupUserMemoryStore: UserMemoryStore = {
      deleteByUserId: async () => true,
      findByUserId: async () => {
        queried = true;
        return OWNER_1_MEMORY;
      },
      upsertFact: async () => OWNER_1_MEMORY,
      upsertPreference: async () => OWNER_1_MEMORY
    };
    const { personaSnapshots, run } = buildChat(dir, {
      composeChatReply: async () => "다들 피곤하구나 ㅋㅋ",
      extraEnv: { MUSE_CHANNEL_ALLOWED_CHATS: "log:-100999", MUSE_CHANNEL_GROUP_ENABLED: "true" },
      userMemoryStore: groupUserMemoryStore
    });

    await run({
      messages: [{ content: CHAT_TEXT, role: "user" }],
      providerId: "log",
      scope: "shared",
      source: "-100999"
    });

    expect(queried).toBe(false);
    expect(personaSnapshots[0]).toEqual([]);
  });

  it("gate ordering: casual 'hi' is answered by the S1 canned reply, never the chat composer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { calls, run } = buildChat(dir, { composeChatReply: async () => "should never run" });
    const reply = await run({ messages: [{ content: "hi", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });

    expect(reply).toBe(casualResponseFor("greeting"));
    expect(calls).toEqual([]);
  });

  it("gate ordering: an unpaired stranger's chat-shaped message still gets the pairing refusal, never a chat reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-chat-"));
    const { calls, run } = buildChat(dir, { composeChatReply: async () => "should never run" });
    await run({ messages: [{ content: DELEGATION_TEXT, role: "user" }], providerId: "log", scope: "direct", source: "owner-1" }); // adopts owner
    calls.length = 0;
    const strangerReply = await run({ messages: [{ content: CHAT_TEXT, role: "user" }], providerId: "log", scope: "direct", source: "stranger-9" });

    expect(strangerReply).toBe("This bot is a private personal assistant and only talks to its paired owner.");
    expect(calls).toEqual([]);
  });
});

// False-done honest-caveat backstop (FIX A): when the user asked Muse to
// remember something date-shaped THIS turn and no followup actually got
// captured, the model's confident "기억해둘게" promise gets a code-appended
// honest caveat — never left to the model to remember to say.
describe("createInboundAgentRun false-done remember-intent backstop", () => {
  // FIX N1 landed deterministic user-side scheduling: a date the RULE
  // detector CAN resolve ("8월 5일", "tomorrow morning") now actually gets
  // scheduled from the user's own text, so these two caveat cases use a
  // date-ish phrase the rule detector does NOT (yet) resolve — 모레/"next
  // week" — the genuinely-unresolvable residual gap the caveat still covers.
  // See "createInboundAgentRun FIX N1" below for the now-successful cases.
  const REMEMBER_KO = "모레 아침에 알려달라고 기억해줘";
  const REMEMBER_EN = "remind me next week about the dentist";

  function buildRemember(dir: string, output: string) {
    const followupsFile = join(dir, "followups.json");
    const registry = new MessagingProviderRegistry([
      new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
    ]);
    const agentRuntime = {
      run: async () => ({ response: { output }, toolsUsed: [] })
    };
    const env = {
      MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
      MUSE_CHANNEL_OWNERS_FILE: join(dir, "channel-owners.json"),
      MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
      MUSE_FOLLOWUPS_FILE: followupsFile,
      MUSE_PENDING_APPROVALS_FILE: join(dir, "pending.json")
    };
    return { followupsFile, run: createInboundAgentRun({ agentRuntime, env, model: "default", registry }) };
  }

  it("remember-intent + nothing scheduled this turn → the KO caveat is appended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-remember-"));
    const { run } = buildRemember(dir, "그때 알려줄게!");
    const reply = await run({ messages: [{ content: REMEMBER_KO, role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).toContain("그때 알려줄게!");
    expect(reply).toContain("예약이 안 됐어");
  });

  it("remember-intent (EN) + nothing scheduled this turn → the EN caveat is appended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-remember-"));
    // Phrased as "I'll remember" (not "I'll remind you…") so it does NOT also
    // trip the separate, pre-existing honest-action guard's ACTION_PROMISE_RE
    // — this test isolates the NEW backstop, not the old one.
    const { run } = buildRemember(dir, "Got it, I'll remember that for you!");
    const reply = await run({ messages: [{ content: REMEMBER_EN, role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).toContain("Got it, I'll remember that for you!");
    expect(reply).toContain("wasn't actually scheduled");
  });

  it("remember-intent + a followup WAS captured this turn (store count strictly grew) → no caveat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-remember-"));
    const followupsFile = join(dir, "followups.json");
    const registry = new MessagingProviderRegistry([
      new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
    ]);
    // Simulates the real agent-core followup-capture-hook: by the time
    // agentRuntime.run() resolves, the promise it captured is already
    // persisted (its afterComplete hook is awaited before run() returns).
    const agentRuntime = {
      run: async () => {
        const captured: PersistedFollowup = {
          createdAt: NOW().toISOString(),
          id: "fu_1",
          scheduledFor: new Date(NOW().getTime() + 3_600_000).toISOString(),
          status: "scheduled",
          summary: "remind about the dentist",
          userId: "log:owner-1"
        };
        await writeFollowups(followupsFile, [captured]);
        return { response: { output: "그때 알려줄게!" }, toolsUsed: [] };
      }
    };
    const env = {
      MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
      MUSE_CHANNEL_OWNERS_FILE: join(dir, "channel-owners.json"),
      MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
      MUSE_FOLLOWUPS_FILE: followupsFile,
      MUSE_PENDING_APPROVALS_FILE: join(dir, "pending.json")
    };
    const run = createInboundAgentRun({ agentRuntime, env, model: "default", registry });
    const reply = await run({ messages: [{ content: REMEMBER_KO, role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).toBe("그때 알려줄게!");
    expect(reply).not.toContain("예약이 안 됐어");
  });

  it("PRE-EXISTING scheduled followups don't mask a miss — the count must STRICTLY GROW this turn, not just be non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-remember-"));
    const followupsFile = join(dir, "followups.json");
    const existing: PersistedFollowup = {
      createdAt: NOW().toISOString(),
      id: "fu_old",
      scheduledFor: new Date(NOW().getTime() + 3_600_000).toISOString(),
      status: "scheduled",
      summary: "an earlier unrelated promise",
      userId: "log:owner-1"
    };
    await writeFollowups(followupsFile, [existing]);
    const registry = new MessagingProviderRegistry([
      new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
    ]);
    const agentRuntime = { run: async () => ({ response: { output: "그때 알려줄게!" }, toolsUsed: [] }) };
    const env = {
      MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
      MUSE_CHANNEL_OWNERS_FILE: join(dir, "channel-owners.json"),
      MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
      MUSE_FOLLOWUPS_FILE: followupsFile,
      MUSE_PENDING_APPROVALS_FILE: join(dir, "pending.json")
    };
    const run = createInboundAgentRun({ agentRuntime, env, model: "default", registry });
    const reply = await run({ messages: [{ content: REMEMBER_KO, role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).toContain("예약이 안 됐어");
  });

  it("plain chat (no remember-intent) → no caveat, no followups-file read side effect on the reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-remember-"));
    const { run } = buildRemember(dir, "answer [from a.md].");
    const reply = await run({ messages: [{ content: "what is my rent?", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).not.toContain("예약이 안 됐어");
    expect(reply).not.toContain("wasn't actually scheduled");
  });

  it("a date mention with NO remember-verb → no caveat (not a remember-intent turn)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-remember-"));
    const { run } = buildRemember(dir, "내일 미팅 오후 3시야.");
    const reply = await run({ messages: [{ content: "내일 미팅 몇시야?", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).toBe("내일 미팅 오후 3시야.");
  });
});

// FIX N1 — scheduling a reminder used to work ONLY as a coin-flip (the
// runtime's followup-capture-hook scans the ASSISTANT's echo, never the
// user's own ask). This extracts + persists straight from the user's text
// (through the SAME `upsertFollowup` store the hook uses), so the followup
// lands regardless of whether the model happens to restate the date, and
// appends a CODE-derived confirmation echo naming the persisted date.
describe("createInboundAgentRun FIX N1 — deterministic user-side scheduling", () => {
  function buildN1(dir: string, output: string) {
    const followupsFile = join(dir, "followups.json");
    const registry = new MessagingProviderRegistry([
      new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
    ]);
    const agentRuntime = {
      run: async () => ({ response: { output }, toolsUsed: [] })
    };
    const env = {
      MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
      MUSE_CHANNEL_OWNERS_FILE: join(dir, "channel-owners.json"),
      MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
      MUSE_FOLLOWUPS_FILE: followupsFile,
      MUSE_PENDING_APPROVALS_FILE: join(dir, "pending.json")
    };
    return { followupsFile, run: createInboundAgentRun({ agentRuntime, env, model: "default", registry }) };
  }

  it("\"다음달 15일 기말고사 까먹지 않게 해줘\" — the followup gets persisted at next month's 15th (no assistant echo needed), the confirmation echo is appended, and NO caveat fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-n1-"));
    // The model's own reply carries NO commissive date phrase at all — the
    // pre-fix coin-flip would have missed this turn entirely.
    const { followupsFile, run } = buildN1(dir, "걱정 마, 잘 챙길게!");
    const reply = await run({ messages: [{ content: "다음달 15일 기말고사 까먹지 않게 해줘", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });

    const followups = await readFollowups(followupsFile);
    const scheduled = followups.filter((f) => f.userId === "log:owner-1" && f.status === "scheduled");
    expect(scheduled).toHaveLength(1);
    const scheduledFor = new Date(scheduled[0]!.scheduledFor);
    const now = new Date();
    const expectedMonthIndex = (now.getMonth() + 1) % 12;
    expect(scheduledFor.getMonth()).toBe(expectedMonthIndex);
    expect(scheduledFor.getDate()).toBe(15);

    expect(reply).toContain("걱정 마, 잘 챙길게!");
    expect(reply).toContain("📌");
    expect(reply).not.toContain("예약이 안 됐어");
  });

  it("EN — \"remind me tomorrow morning about the dentist\" now schedules from the user's own ask and confirms in English", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-n1-"));
    const { followupsFile, run } = buildN1(dir, "Sure thing!");
    const reply = await run({ messages: [{ content: "remind me tomorrow morning about the dentist", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });

    const followups = await readFollowups(followupsFile);
    expect(followups.filter((f) => f.userId === "log:owner-1" && f.status === "scheduled")).toHaveLength(1);
    expect(reply).toContain("Sure thing!");
    expect(reply).toContain("📌");
    expect(reply).not.toContain("wasn't actually scheduled");
  });

  it("dedup — the assistant's OWN commissive echo already scheduled the SAME date this turn: no duplicate followup, still exactly one confirmation echo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-n1-"));
    const followupsFile = join(dir, "followups.json");
    const registry = new MessagingProviderRegistry([
      new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
    ]);
    // Simulates the runtime's OWN followup-capture-hook firing on a
    // commissive assistant echo for the SAME date the user asked about —
    // by the time agentRuntime.run() resolves this is already persisted.
    const agentRuntime = {
      run: async () => {
        const now = new Date();
        const nextMonthIndex = (now.getMonth() + 1) % 12;
        const nextMonthYear = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
        const scheduledFor = new Date(nextMonthYear, nextMonthIndex, 15, 9, 0, 0, 0);
        const captured: PersistedFollowup = {
          createdAt: now.toISOString(),
          id: "fu_hook_echo",
          scheduledFor: scheduledFor.toISOString(),
          status: "scheduled",
          summary: "기말고사 알려드릴게요",
          userId: "log:owner-1"
        };
        await writeFollowups(followupsFile, [captured]);
        return { response: { output: "네! 다음달 15일에 알려드릴게요!" }, toolsUsed: [] };
      }
    };
    const env = {
      MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
      MUSE_CHANNEL_OWNERS_FILE: join(dir, "channel-owners.json"),
      MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
      MUSE_FOLLOWUPS_FILE: followupsFile,
      MUSE_PENDING_APPROVALS_FILE: join(dir, "pending.json")
    };
    const run = createInboundAgentRun({ agentRuntime, env, model: "default", registry });
    const reply = await run({ messages: [{ content: "다음달 15일 기말고사 까먹지 않게 해줘", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });

    const followups = await readFollowups(followupsFile);
    const scheduled = followups.filter((f) => f.userId === "log:owner-1" && f.status === "scheduled");
    expect(scheduled).toHaveLength(1); // NOT two — the hook's entry already covered it
    expect(scheduled[0]?.id).toBe("fu_hook_echo"); // the user-side path skipped writing a duplicate
    expect(reply.match(/📌/gu)).toHaveLength(1);
    expect(reply).not.toContain("예약이 안 됐어");
  });

  it("interplay — FIX N1b recurrence suppression means a recurring ask still gets the honest caveat, not a wrong one-shot: \"수요일마다 6시\"", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-n1-"));
    const { followupsFile, run } = buildN1(dir, "알았어!");
    const reply = await run({ messages: [{ content: "수요일마다 6시에 회의 있는거 잊지 마", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });

    const followups = await readFollowups(followupsFile);
    expect(followups.filter((f) => f.userId === "log:owner-1" && f.status === "scheduled")).toHaveLength(0);
    expect(reply).toContain("예약이 안 됐어");
    expect(reply).not.toContain("📌");
  });

  it("interplay — \"매일 아침 8시 혈압약\" also collapses to the honest caveat, not a bogus today-08:00 one-shot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-n1-"));
    const { followupsFile, run } = buildN1(dir, "알았어!");
    const reply = await run({ messages: [{ content: "매일 아침 8시 혈압약 먹는거 잊지 마", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });

    const followups = await readFollowups(followupsFile);
    expect(followups.filter((f) => f.userId === "log:owner-1" && f.status === "scheduled")).toHaveLength(0);
    expect(reply).toContain("예약이 안 됐어");
    expect(reply).not.toContain("📌");
  });

  it("the confirmation echo does NOT fire on plain chat (no remember-intent → the scheduling path never runs)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-n1-"));
    const { run } = buildN1(dir, "오늘은 화창해!");
    const reply = await run({ messages: [{ content: "오늘 날씨 어때?", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(reply).toBe("오늘은 화창해!");
    expect(reply).not.toContain("📌");
  });
});
