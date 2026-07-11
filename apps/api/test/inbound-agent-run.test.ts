import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UNGROUNDABLE_ANSWER_NOTICE } from "@muse/agent-core";
import { LogMessagingProvider, MessagingProviderRegistry } from "@muse/messaging";
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
}) {
  const dir = mkdtempSync(join(tmpdir(), "muse-inbound-gate-"));
  const registry = new MessagingProviderRegistry([
    new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
  ]);
  const agentRuntime = {
    run: async () => ({
      response: { output: result.output },
      ...(result.groundingSources ? { groundingSources: result.groundingSources } : {})
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
    const reply = await run({ messages: [{ content: "hi", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    expect(agentCalls).toEqual(["run"]);
    expect(reply).toContain("answer");
  });

  it("refuses a SECOND chat deterministically — the agent never runs and no personal data flows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-pairing-"));
    const agentCalls: string[] = [];
    const run = buildGated(dir, agentCalls);
    await run({ messages: [{ content: "hi", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });

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
    await run({ messages: [{ content: "hi", role: "user" }], providerId: "log", scope: "direct", source: "owner-1" });
    const familyReply = await run({ messages: [{ content: "hello", role: "user" }], providerId: "log", scope: "direct", source: "family-2" });
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
    const { recordPendingApproval } = await import("@muse/messaging");
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
