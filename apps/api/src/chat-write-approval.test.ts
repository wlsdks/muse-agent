import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRunInput } from "@muse/agent-core";
import {
  CLAIM_RECOVERY_LEASE_MS,
  claimPendingApproval,
  completePendingApproval,
  declinePendingApprovalClaim,
  listPendingApprovals,
  recordPendingApproval,
  type PendingApproval
} from "@muse/messaging";
import type { JsonObject } from "@muse/shared";
import type { MuseTool, ToolExecutionValue } from "@muse/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeChatApproval } from "./chat-approval-execute.js";
import { runChat } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

vi.mock("@muse/messaging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muse/messaging")>();
  return {
    ...actual,
    completePendingApproval: vi.fn(actual.completePendingApproval)
  };
});

let dir: string;
let pendingFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-chat-write-"));
  pendingFile = join(dir, "pending-approvals.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

interface FakeRuntime {
  readonly captured: AgentRunInput[];
  run(input: AgentRunInput): Promise<unknown>;
  stream(): AsyncIterable<unknown>;
}

/**
 * A runtime that records each run input and — when a run-scoped approval gate
 * is wired — simulates the model attempting exactly one `muse.tasks.add` write,
 * so the gate's capture/deny path is exercised without a real model.
 */
function fakeRuntime(): FakeRuntime {
  const captured: AgentRunInput[] = [];
  let gated = false;
  return {
    captured,
    async run(input: AgentRunInput) {
      captured.push(input);
      if (input.toolApprovalGate && !gated) {
        gated = true;
        await input.toolApprovalGate({
          risk: "write",
          runId: "r1",
          toolCall: { arguments: { title: "Buy milk" }, id: "c1", name: "muse.tasks.add" }
        });
      }
      return { response: { model: "test-model", output: "Understood." }, runId: "r1", toolsUsed: [], groundingSources: [] };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("stream unused in this test");
    }
  };
}

function recordingTool(name: string, result: unknown): { readonly tool: MuseTool; readonly calls: JsonObject[] } {
  const calls: JsonObject[] = [];
  const tool: MuseTool = {
    definition: { description: "test", inputSchema: {}, name, risk: "write" },
    execute(args: JsonObject) {
      calls.push(args);
      return result as ToolExecutionValue;
    }
  };
  return { calls, tool };
}

function optionsFor(runtime: FakeRuntime, env: Record<string, string | undefined>): ServerOptions {
  return {
    agentRuntime: runtime as unknown as ServerOptions["agentRuntime"],
    defaultModel: "test-model",
    env
  } as ServerOptions;
}

const stubReply = {
  status: () => ({ send: () => undefined }),
  header: () => undefined,
  send: () => undefined
};

describe("runChat write-approval wiring", () => {
  it("flag OFF: no authority/gate on the run input, nothing persisted", async () => {
    const runtime = fakeRuntime();
    const options = optionsFor(runtime, { MUSE_PENDING_APPROVALS_FILE: pendingFile });
    const res = await runChat({ message: "add buy milk" }, stubReply, options, "compat") as { content: string };
    expect(runtime.captured[0]?.toolApprovalGate).toBeUndefined();
    expect(runtime.captured[0]?.toolExposureAuthority).toBeUndefined();
    expect(res.content).not.toContain("needs your approval");
    expect(await listPendingApprovals(pendingFile)).toHaveLength(0);
  });

  it("flag ON: write is captured (not executed), persisted, and the notice appended", async () => {
    const runtime = fakeRuntime();
    const options = optionsFor(runtime, { MUSE_CHAT_WRITE_ENABLED: "true", MUSE_PENDING_APPROVALS_FILE: pendingFile });
    const res = await runChat({ message: "add buy milk", userId: "owner" }, stubReply, options, "compat") as {
      content: string;
      pendingApprovals: { id: string; tool: string; draft: string }[];
    };

    expect(runtime.captured[0]?.toolApprovalGate).toBeDefined();
    expect(runtime.captured[0]?.toolExposureAuthority).toBeDefined();

    const pending = await listPendingApprovals(pendingFile);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      arguments: { title: "Buy milk" },
      draft: "title=Buy milk",
      providerId: "chat",
      risk: "write",
      source: "api-chat",
      tool: "muse.tasks.add",
      userId: "owner"
    });

    expect(res.content).toContain("🔒 These actions need your approval before I run them:");
    expect(res.content).toContain("muse.tasks.add");

    // The envelope carries the structured pending approval WITH the persisted id
    // (the text notice alone has none), so the client can call the approve route.
    expect(res.pendingApprovals).toHaveLength(1);
    expect(res.pendingApprovals[0]).toEqual({ draft: "title=Buy milk", id: pending[0]!.id, tool: "muse.tasks.add" });
  });

  it("flag OFF: pendingApprovals is an empty array (no ids surfaced)", async () => {
    const runtime = fakeRuntime();
    const options = optionsFor(runtime, { MUSE_PENDING_APPROVALS_FILE: pendingFile });
    const res = await runChat({ message: "hi" }, stubReply, options, "compat") as { pendingApprovals: unknown[] };
    expect(res.pendingApprovals).toEqual([]);
  });
});

function pendingEntry(overrides: Partial<PendingApproval> & Pick<PendingApproval, "id" | "tool">): PendingApproval {
  const now = Date.now();
  return {
    arguments: { title: "Buy milk" },
    createdAt: new Date(now).toISOString(),
    draft: "title=Buy milk",
    expiresAt: new Date(now + 60_000).toISOString(),
    providerId: "chat",
    risk: "write",
    source: "api-chat",
    ...overrides
  };
}

describe("executeChatApproval confirm-execute", () => {
  it("confirms a valid id: executes once and clears the entry", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "a1", tool: "muse.tasks.add" }));
    const { tool, calls } = recordingTool("muse.tasks.add", { ok: true });

    const out = await executeChatApproval({ id: "a1", pendingFile, resolveTool: () => tool });

    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ ran: true, tool: "muse.tasks.add" });
    expect(calls).toEqual([{ title: "Buy milk" }]);
    expect(await listPendingApprovals(pendingFile)).toHaveLength(0);
  });

  it("explicit recovery re-enters the coordinator for a stale allowlisted pre-effect claim", async () => {
    const claimedAt = new Date("2026-07-18T01:00:00.000Z");
    await recordPendingApproval(pendingFile, pendingEntry({
      createdAt: "2026-07-18T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      id: "recover-api",
      tool: "muse.tasks.add",
      userId: "owner"
    }));
    await claimPendingApproval(pendingFile, "recover-api", { requestUserId: "owner", surface: "api" }, () => claimedAt);
    const { tool, calls } = recordingTool("muse.tasks.add", { ok: true });

    const out = await executeChatApproval({
      acquisition: "recover-stale-claim",
      id: "recover-api",
      now: () => new Date(claimedAt.getTime() + CLAIM_RECOVERY_LEASE_MS),
      pendingFile,
      requestUserId: "owner",
      resolveTool: () => tool
    });

    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ ran: true, state: "succeeded", tool: "muse.tasks.add" });
    expect(calls).toEqual([{ title: "Buy milk" }]);
  });

  it("unknown id: 404, no execution", async () => {
    const { tool, calls } = recordingTool("muse.tasks.add", { ok: true });
    const out = await executeChatApproval({ id: "missing", pendingFile, resolveTool: () => tool });
    expect(out.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("expired id: 404, no execution", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({
      createdAt: "2019-12-31T23:59:00.000Z",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      id: "expired",
      tool: "muse.tasks.add"
    }));
    const { tool, calls } = recordingTool("muse.tasks.add", { ok: true });
    const out = await executeChatApproval({ id: "expired", pendingFile, resolveTool: () => tool });
    expect(out.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("replay: a durable succeeded claim blocks a second approve without executing", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "r1", tool: "muse.tasks.add" }));
    const { tool, calls } = recordingTool("muse.tasks.add", { ok: true });

    const first = await executeChatApproval({ id: "r1", pendingFile, resolveTool: () => tool });
    const second = await executeChatApproval({ id: "r1", pendingFile, resolveTool: () => tool });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.body).toMatchObject({ state: "succeeded" });
    expect(calls).toHaveLength(1);
  });

  it("resolver missing: closes the claimed approval as unknown and replay cannot execute", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "n1", tool: "muse.tasks.add" }));
    const out = await executeChatApproval({ id: "n1", pendingFile });
    expect(out.statusCode).toBe(409);
    expect(out.body).toMatchObject({ state: "unknown" });
    expect(await listPendingApprovals(pendingFile)).toHaveLength(0);

    const { tool, calls } = recordingTool("muse.tasks.add", { ok: true });
    const replay = await executeChatApproval({ id: "n1", pendingFile, resolveTool: () => tool });
    expect(replay.body).toMatchObject({ state: "unknown" });
    expect(calls).toHaveLength(0);
  });

  it("unknown tool: closes the claimed approval as unknown", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "u1", tool: "muse.tasks.add" }));
    const out = await executeChatApproval({ id: "u1", pendingFile, resolveTool: () => undefined });
    expect(out.statusCode).toBe(409);
    expect(out.body).toMatchObject({ state: "unknown" });
    expect(await listPendingApprovals(pendingFile)).toHaveLength(0);
  });

  it("begin loser reports the actual durable state and never invokes the prepared effect", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "begin-race", tool: "muse.tasks.add" }));
    const { tool, calls } = recordingTool("muse.tasks.add", { ok: true });
    const actual = await vi.importActual<typeof import("@muse/messaging")>("@muse/messaging");
    vi.mocked(completePendingApproval).mockImplementationOnce((options) => {
      return actual.completePendingApproval({
        ...options,
        operations: {
          begin: async (file, id, claimToken, now) => {
            await declinePendingApprovalClaim(file, id, claimToken, "denied during begin race", now);
            return { state: "denied", transitioned: false };
          }
        }
      });
    });

    const out = await executeChatApproval({ id: "begin-race", pendingFile, resolveTool: () => tool });
    const replay = await executeChatApproval({ id: "begin-race", pendingFile, resolveTool: () => tool });

    expect(out.statusCode).toBe(409);
    expect(out.body).toMatchObject({ state: "denied" });
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toMatchObject({ state: "denied" });
    expect(calls).toHaveLength(0);
  });

  it("resolves and executes only from the immutable snapshot claimed by the coordinator", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({
      arguments: { title: "old" },
      draft: "title=old",
      id: "snapshot-race",
      tool: "muse.tasks.add"
    }));
    const replacement = pendingEntry({
      arguments: { body: "new snapshot" },
      draft: "body=new snapshot",
      id: "snapshot-race",
      tool: "muse.notes.save"
    });
    const actual = await vi.importActual<typeof import("@muse/messaging")>("@muse/messaging");
    vi.mocked(completePendingApproval).mockImplementationOnce(async (options) => {
      await writeFile(options.file, `${JSON.stringify({ pending: [replacement] }, null, 2)}\n`, "utf8");
      return actual.completePendingApproval(options);
    });
    const { tool, calls } = recordingTool("muse.notes.save", { ok: true });
    const resolved: string[] = [];

    const out = await executeChatApproval({
      id: "snapshot-race",
      pendingFile,
      resolveTool: (name) => {
        resolved.push(name);
        return name === "muse.notes.save" ? tool : undefined;
      }
    });

    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ state: "succeeded", tool: "muse.notes.save" });
    expect(resolved).toEqual(["muse.notes.save"]);
    expect(calls).toEqual([{ body: "new snapshot" }]);
  });

  it("error-shaped tool result: ran:false, durable unknown, and replay does not execute", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "e1", tool: "muse.tasks.add" }));
    const { tool, calls } = recordingTool("muse.tasks.add", { error: "provider down" });

    const out = await executeChatApproval({ id: "e1", pendingFile, resolveTool: () => tool });

    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ ran: false, state: "unknown", tool: "muse.tasks.add" });
    expect(calls).toHaveLength(1);
    expect(await listPendingApprovals(pendingFile)).toHaveLength(0);

    const replay = await executeChatApproval({ id: "e1", pendingFile, resolveTool: () => tool });
    expect(replay.body).toMatchObject({ state: "unknown" });
    expect(calls).toHaveLength(1);
  });

  it("a contradictory positive marker plus provider error is durable unknown, never succeeded", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "contradictory-1", tool: "muse.tasks.add" }));
    const { tool, calls } = recordingTool("muse.tasks.add", { error: "provider failed", ok: true });

    const out = await executeChatApproval({ id: "contradictory-1", pendingFile, resolveTool: () => tool });
    const replay = await executeChatApproval({ id: "contradictory-1", pendingFile, resolveTool: () => tool });

    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ ran: false, state: "unknown" });
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toMatchObject({ state: "unknown" });
    expect(calls).toHaveLength(1);
  });

  it("a sent result contradicted by performed:false is durable unknown and cannot replay", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "contradictory-performed", tool: "muse.tasks.add" }));
    const { tool, calls } = recordingTool("muse.tasks.add", { performed: false, sent: true });

    const out = await executeChatApproval({ id: "contradictory-performed", pendingFile, resolveTool: () => tool });
    const replay = await executeChatApproval({ id: "contradictory-performed", pendingFile, resolveTool: () => tool });

    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ ran: false, state: "unknown" });
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toMatchObject({ state: "unknown" });
    expect(calls).toHaveLength(1);
  });

  it("a completed result contradicted by sent:false is durable unknown and cannot replay", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "contradictory-sent", tool: "muse.tasks.add" }));
    const { tool, calls } = recordingTool("muse.tasks.add", { completed: true, sent: false });

    const out = await executeChatApproval({ id: "contradictory-sent", pendingFile, resolveTool: () => tool });
    const replay = await executeChatApproval({ id: "contradictory-sent", pendingFile, resolveTool: () => tool });

    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ ran: false, state: "unknown" });
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toMatchObject({ state: "unknown" });
    expect(calls).toHaveLength(1);
  });

  it("a throwing tool is finalized unknown and cannot be retried", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "throw-1", tool: "muse.tasks.add" }));
    let calls = 0;
    const tool: MuseTool = {
      definition: { description: "test", inputSchema: {}, name: "muse.tasks.add", risk: "write" },
      execute() {
        calls += 1;
        throw new Error("provider crashed");
      }
    };

    const out = await executeChatApproval({ id: "throw-1", pendingFile, resolveTool: () => tool });
    const replay = await executeChatApproval({ id: "throw-1", pendingFile, resolveTool: () => tool });

    expect(out.statusCode).toBe(500);
    expect(out.body).toMatchObject({ state: "unknown" });
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toMatchObject({ state: "unknown" });
    expect(calls).toBe(1);
  });

  it("finalize CAS loser returns 500 with the actual durable state and replay never re-executes", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "finalize-loser", tool: "muse.tasks.add" }));
    const { tool, calls } = recordingTool("muse.tasks.add", { ok: true });
    const actual = await vi.importActual<typeof import("@muse/messaging")>("@muse/messaging");
    vi.mocked(completePendingApproval).mockImplementationOnce((options) => {
      return actual.completePendingApproval({
        ...options,
        operations: {
          finalize: async (file, id, claimToken, _state, _detail, now) => {
            await actual.finalizePendingApprovalExecution(file, id, claimToken, "unknown", "rival finalizer won", now);
            return { state: "unknown", transitioned: false };
          }
        }
      });
    });

    const out = await executeChatApproval({ id: "finalize-loser", pendingFile, resolveTool: () => tool });
    const replay = await executeChatApproval({ id: "finalize-loser", pendingFile, resolveTool: () => tool });

    expect(out.statusCode).toBe(500);
    expect(out.body).toMatchObject({ phase: "finalize", state: "unknown" });
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toMatchObject({ state: "unknown" });
    expect(calls).toHaveLength(1);
  });

  it("finalize throw maps persistence uncertainty to 500 and replay never re-executes", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "finalize-throw", tool: "muse.tasks.add" }));
    const { tool, calls } = recordingTool("muse.tasks.add", { ok: true });
    const actual = await vi.importActual<typeof import("@muse/messaging")>("@muse/messaging");
    vi.mocked(completePendingApproval).mockImplementationOnce((options) => {
      return actual.completePendingApproval({
        ...options,
        operations: {
          finalize: async () => {
            throw new Error("fsync failed");
          }
        }
      });
    });

    const out = await executeChatApproval({ id: "finalize-throw", pendingFile, resolveTool: () => tool });
    const replay = await executeChatApproval({ id: "finalize-throw", pendingFile, resolveTool: () => tool });

    expect(out.statusCode).toBe(500);
    expect(out.body).toMatchObject({
      certainty: "observed",
      effectAttempted: true,
      phase: "finalize",
      state: "executing"
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toMatchObject({ state: "executing" });
    expect(calls).toHaveLength(1);
  });

  it("user-scope: a DIFFERENT authenticated user cannot approve — 403, no execution, entry left pending", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "s1", tool: "muse.tasks.add", userId: "owner" }));
    const { tool, calls } = recordingTool("muse.tasks.add", { ok: true });

    const out = await executeChatApproval({ id: "s1", pendingFile, requestUserId: "intruder", resolveTool: () => tool });

    expect(out.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
    expect(await listPendingApprovals(pendingFile)).toHaveLength(1);
  });

  it("user-scope: the SAME user approves normally", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "s2", tool: "muse.tasks.add", userId: "owner" }));
    const { tool, calls } = recordingTool("muse.tasks.add", { ok: true });

    const out = await executeChatApproval({ id: "s2", pendingFile, requestUserId: "owner", resolveTool: () => tool });

    expect(out.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("user-scope: no auth (requestUserId absent) still approves a user-owned entry — the single-user local posture", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "s3", tool: "muse.tasks.add", userId: "owner" }));
    const { tool, calls } = recordingTool("muse.tasks.add", { ok: true });

    const out = await executeChatApproval({ id: "s3", pendingFile, resolveTool: () => tool });

    expect(out.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("maps persistence uncertainty to 500 and preserves the observed durable state", async () => {
    vi.mocked(completePendingApproval).mockResolvedValueOnce({
      certainty: "observed",
      effectAttempted: true,
      error: "fsync failed",
      kind: "persistence-uncertain",
      phase: "finalize",
      state: "executing"
    });

    const out = await executeChatApproval({ id: "uncertain", pendingFile, resolveTool: () => undefined });

    expect(out.statusCode).toBe(500);
    expect(out.body).toMatchObject({
      certainty: "observed",
      effectAttempted: true,
      phase: "finalize",
      state: "executing"
    });
  });
});
