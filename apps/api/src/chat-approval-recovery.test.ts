import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimPendingApproval, recordPendingApproval, type PendingApproval } from "@muse/messaging";
import type { JsonObject } from "@muse/shared";
import type { MuseTool, ToolExecutionValue } from "@muse/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "./server.js";
import type { ServerOptions } from "./server.js";

let dir: string;
let pendingFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chat-approval-recovery-"));
  pendingFile = join(dir, "pending.json");
});
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

function pending(id: string): PendingApproval {
  const now = Date.now();
  return {
    arguments: { title: "private title" },
    createdAt: new Date(now - 30 * 60_000).toISOString(),
    draft: "title=private title",
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    id,
    providerId: "chat",
    risk: "write",
    source: "api-chat",
    tool: "muse.tasks.add",
    userId: "owner"
  };
}

function serverOptions(tool: MuseTool, userId = "owner"): ServerOptions {
  return {
    approvalToolResolver: (name) => name === "muse.tasks.add" ? tool : undefined,
    authService: {
      authenticateBearer: async () => ({ userId })
    } as unknown as ServerOptions["authService"],
    env: { MUSE_PENDING_APPROVALS_FILE: pendingFile },
    requireAuth: true
  };
}

describe("approval status and stale-claim recovery routes", () => {
  it("returns redacted status and explicitly recovers through the shared execution path once", async () => {
    await recordPendingApproval(pendingFile, pending("route-recover"));
    await claimPendingApproval(
      pendingFile,
      "route-recover",
      { requestUserId: "owner", surface: "api" },
      () => new Date(Date.now() - 16 * 60_000)
    );
    const calls: JsonObject[] = [];
    const tool: MuseTool = {
      definition: { description: "task add", inputSchema: {}, name: "muse.tasks.add", risk: "write" },
      execute: (args) => {
        calls.push(args);
        return { ok: true } as ToolExecutionValue;
      }
    };
    const server = buildServer(serverOptions(tool));
    const headers = { authorization: "Bearer owner" };

    const status = await server.inject({ headers, method: "GET", url: "/api/chat/approvals/route-recover/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      effectMayHaveOccurred: false,
      id: "route-recover",
      recoverable: true,
      state: "claimed",
      tool: "muse.tasks.add"
    });
    expect(status.body).not.toContain("private task payload");
    expect(status.body).not.toContain("claimToken");
    expect(status.body).not.toContain("effectiveUser");

    const recovered = await server.inject({ headers, method: "POST", payload: {}, url: "/api/chat/approvals/route-recover/recover" });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ ran: true, state: "succeeded", tool: "muse.tasks.add" });
    const replay = await server.inject({ headers, method: "POST", payload: {}, url: "/api/chat/approvals/route-recover/recover" });
    expect(replay.statusCode).toBe(409);
    expect(calls).toEqual([{ title: "private title" }]);
    await server.close();
  });

  it("keeps a recovered task mutation unknown when its result contains a negative marker", async () => {
    await recordPendingApproval(pendingFile, pending("negative-recovery"));
    await claimPendingApproval(
      pendingFile,
      "negative-recovery",
      { requestUserId: "owner", surface: "api" },
      () => new Date(Date.now() - 16 * 60_000)
    );
    let calls = 0;
    const tool: MuseTool = {
      definition: { description: "task add", inputSchema: {}, name: "muse.tasks.add", risk: "write" },
      execute: () => {
        calls += 1;
        return { ok: false, task: { id: "task-1" } };
      }
    };
    const server = buildServer(serverOptions(tool));
    const headers = { authorization: "Bearer owner" };

    const recovered = await server.inject({ headers, method: "POST", payload: {}, url: "/api/chat/approvals/negative-recovery/recover" });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ ran: false, state: "unknown", tool: "muse.tasks.add" });
    const replay = await server.inject({ headers, method: "POST", payload: {}, url: "/api/chat/approvals/negative-recovery/recover" });
    expect(replay.statusCode).toBe(409);
    expect(calls).toBe(1);
    await server.close();
  });

  it("returns no metadata for owner mismatch/expiry and rejects a non-empty recovery body", async () => {
    await recordPendingApproval(pendingFile, pending("owned"));
    await recordPendingApproval(pendingFile, {
      ...pending("expired"),
      createdAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-02T00:00:00.000Z"
    });
    const tool: MuseTool = {
      definition: { description: "task add", inputSchema: {}, name: "muse.tasks.add", risk: "write" },
      execute: () => ({ ok: true })
    };
    const intruder = buildServer(serverOptions(tool, "intruder"));
    const headers = { authorization: "Bearer intruder" };

    const forbidden = await intruder.inject({ headers, method: "GET", url: "/api/chat/approvals/owned/status" });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: "this approval belongs to a different user", state: "forbidden" });
    const expired = await intruder.inject({ headers, method: "GET", url: "/api/chat/approvals/expired/status" });
    expect(expired.statusCode).toBe(404);
    expect(expired.json()).toMatchObject({ state: "expired" });
    const nonEmpty = await intruder.inject({ headers, method: "POST", payload: { force: true }, url: "/api/chat/approvals/owned/recover" });
    expect(nonEmpty.statusCode).toBe(400);
    await intruder.close();
  });
});
