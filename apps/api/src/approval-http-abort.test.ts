import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectPendingApprovalStatus,
  recordPendingApproval,
  type PendingApproval
} from "@muse/messaging";
import type { MuseTool } from "@muse/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "./server.js";

let dir: string;
let pendingFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "approval-http-abort-"));
  pendingFile = join(dir, "pending.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

function pending(id: string): PendingApproval {
  return {
    arguments: { title: "Buy milk" },
    createdAt: "2026-07-29T00:00:00.000Z",
    draft: "title=Buy milk",
    expiresAt: "2030-01-01T00:00:00.000Z",
    id,
    providerId: "chat",
    risk: "write",
    source: "api-chat",
    tool: "muse.tasks.add"
  };
}

describe("approval HTTP cancellation", () => {
  it("does not abort a normal real HTTP approval request", async () => {
    await recordPendingApproval(pendingFile, pending("normal"));
    let observedSignal: AbortSignal | undefined;
    const tool: MuseTool = {
      definition: { description: "task add", inputSchema: {}, name: "muse.tasks.add", risk: "write" },
      execute(_args, context) {
        observedSignal = context.signal;
        return { performed: true };
      }
    };
    const server = buildServer({
      approvalToolResolver: () => tool,
      env: { MUSE_PENDING_APPROVALS_FILE: pendingFile },
      logger: false
    });

    try {
      await server.listen({ host: "127.0.0.1", port: 0 });
      const address = server.server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/approvals/normal/approve`, {
        method: "POST"
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ran: true, state: "succeeded" });
      expect(observedSignal).toBeDefined();
      expect(observedSignal?.aborted).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("aborts an in-flight approval on real client disconnect, settles unknown, and blocks replay", async () => {
    await recordPendingApproval(pendingFile, pending("disconnect"));
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    let effects = 0;
    const tool: MuseTool = {
      definition: { description: "task add", inputSchema: {}, name: "muse.tasks.add", risk: "write" },
      execute(_args, context) {
        effects += 1;
        started.resolve();
        return new Promise((_resolve, reject) => {
          const rejectAborted = (): void => {
            aborted.resolve();
            const error = new Error("client disconnected");
            error.name = "AbortError";
            reject(error);
          };
          if (context.signal?.aborted) rejectAborted();
          else context.signal?.addEventListener("abort", rejectAborted, { once: true });
        });
      }
    };
    const server = buildServer({
      approvalToolResolver: () => tool,
      env: { MUSE_PENDING_APPROVALS_FILE: pendingFile },
      logger: false
    });

    try {
      await server.listen({ host: "127.0.0.1", port: 0 });
      const address = server.server.address() as AddressInfo;
      const client = httpRequest({
        host: "127.0.0.1",
        method: "POST",
        path: "/api/chat/approvals/disconnect/approve",
        port: address.port
      });
      client.on("error", () => {});
      client.end();

      await started.promise;
      client.destroy();
      await aborted.promise;

      await vi.waitFor(async () => {
        const status = await inspectPendingApprovalStatus(pendingFile, "disconnect", { surface: "cli" });
        expect(status).toMatchObject({
          found: true,
          status: { effectMayHaveOccurred: true, state: "unknown" }
        });
      });
      const replay = await server.inject({
        method: "POST",
        url: "/api/chat/approvals/disconnect/approve"
      });
      expect(replay.statusCode).toBe(409);
      expect(replay.json()).toMatchObject({ state: "unknown" });
      expect(effects).toBe(1);
    } finally {
      await server.close();
    }
  });
});
