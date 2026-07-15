import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listPendingApprovals, recordPendingApproval, type PendingApproval } from "@muse/messaging";
import { readActionLog, type ActionLogEntry } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { denyChatApproval } from "./chat-approval-deny.js";

let dir: string;
let pendingFile: string;
let actionLogFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-chat-deny-"));
  pendingFile = join(dir, "pending-approvals.json");
  actionLogFile = join(dir, "action-log.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
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

describe("denyChatApproval confirm-deny", () => {
  it("valid id: clears only that entry, logs a refused entry with the draft, and never executes anything", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "a1", tool: "muse.tasks.add" }));
    await recordPendingApproval(pendingFile, pendingEntry({ id: "a2", tool: "muse.notes.save" }));

    const out = await denyChatApproval({ actionLogFile, id: "a1", pendingFile });

    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ denied: true, tool: "muse.tasks.add" });

    const remaining = await listPendingApprovals(pendingFile);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe("a2");

    const entries = await readActionLog(actionLogFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ gateClass: "muse.tasks.add", result: "refused" });
    expect(entries[0]!.what).toContain("title=Buy milk");
    expect(entries[0]!.why).toContain("denied");
  });

  it("unknown id: 404, pending file unchanged, nothing logged", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "a1", tool: "muse.tasks.add" }));

    const out = await denyChatApproval({ actionLogFile, id: "missing", pendingFile });

    expect(out.statusCode).toBe(404);
    expect(await listPendingApprovals(pendingFile)).toHaveLength(1);
    expect(await readActionLog(actionLogFile)).toHaveLength(0);
  });

  it("expired id: 404, pending file unchanged, nothing logged", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      id: "expired",
      tool: "muse.tasks.add"
    }));

    const out = await denyChatApproval({ actionLogFile, id: "expired", pendingFile });

    expect(out.statusCode).toBe(404);
    expect(await readActionLog(actionLogFile)).toHaveLength(0);
  });

  it("different authenticated user: 403, entry left pending, nothing logged", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "s1", tool: "muse.tasks.add", userId: "owner" }));

    const out = await denyChatApproval({ actionLogFile, id: "s1", pendingFile, requestUserId: "intruder" });

    expect(out.statusCode).toBe(403);
    expect(await listPendingApprovals(pendingFile)).toHaveLength(1);
    expect(await readActionLog(actionLogFile)).toHaveLength(0);
  });

  it("same authenticated user denies normally", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "s2", tool: "muse.tasks.add", userId: "owner" }));

    const out = await denyChatApproval({ actionLogFile, id: "s2", pendingFile, requestUserId: "owner" });

    expect(out.statusCode).toBe(200);
    expect(await listPendingApprovals(pendingFile)).toHaveLength(0);
  });

  it("action-log append failure: 5xx, entry stays pending (denial never silently dropped)", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "f1", tool: "muse.tasks.add" }));
    const failingAppend = vi.fn(async () => {
      throw new Error("disk full");
    });

    const out = await denyChatApproval({ actionLogFile, appendActionLog: failingAppend, id: "f1", pendingFile });

    expect(out.statusCode).toBe(500);
    expect(failingAppend).toHaveBeenCalledTimes(1);
    expect(await listPendingApprovals(pendingFile)).toHaveLength(1);
  });

  it("replay: a second deny of the same id 404s, only one log entry exists", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "r1", tool: "muse.tasks.add" }));

    const first = await denyChatApproval({ actionLogFile, id: "r1", pendingFile });
    const second = await denyChatApproval({ actionLogFile, id: "r1", pendingFile });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(404);
    expect(await readActionLog(actionLogFile)).toHaveLength(1);
  });

  it("uses the injected appendActionLog seam with the resolved action-log file", async () => {
    await recordPendingApproval(pendingFile, pendingEntry({ id: "i1", tool: "muse.tasks.add" }));
    const calls: [string, ActionLogEntry][] = [];
    const append = vi.fn(async (file: string, entry: ActionLogEntry) => {
      calls.push([file, entry]);
    });

    await denyChatApproval({ actionLogFile, appendActionLog: append, id: "i1", pendingFile });

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(actionLogFile);
    expect(calls[0]![1]).toMatchObject({ gateClass: "muse.tasks.add", result: "refused" });
  });
});
