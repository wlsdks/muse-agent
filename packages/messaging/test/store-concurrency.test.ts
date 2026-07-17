import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendAckCursor, readAckCursor } from "../src/inbox-ack-cursor.js";
import { advanceInboxInjectionCursor, readInboxInjectionCursor } from "../src/inbox-injection-cursor.js";
import { appendReplyCursor, readReplyCursor } from "../src/inbox-reply-cursor.js";
import { appendInbound, readInbox } from "../src/inbox-store.js";
import { appendThreadTurns, readThread } from "../src/inbound-thread-store.js";
import {
  beginPendingApprovalExecution,
  claimPendingApproval,
  clearPendingApproval,
  finalizePendingApprovalExecution,
  type PendingApproval,
  readPendingApprovals,
  recordPendingApproval
} from "../src/pending-approval-store.js";
import type { InboundMessage } from "../src/types.js";

let dir: string;
const execFileAsync = promisify(execFile);
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "store-concurrency-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("appendInbound under concurrency — the write-queue serializes, no lost writes", () => {
  const msg = (i: number): InboundMessage =>
    ({ messageId: `m${i}`, providerId: "discord", receivedAtIso: "2026-01-01T00:00:00Z", source: "c1", text: `t${i}` }) as InboundMessage;

  it("preserves every record when many appends race on the same file", async () => {
    const file = join(dir, "inbox.json");
    await Promise.all(Array.from({ length: 25 }, (_v, i) => appendInbound(file, msg(i))));
    const ids = (await readInbox(file, 100)).map((m) => m.messageId).sort();
    expect(ids).toEqual(Array.from({ length: 25 }, (_v, i) => `m${i}`).sort());
  });

  it("does not let concurrent writes to different files interfere", async () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    await Promise.all([appendInbound(a, msg(1)), appendInbound(b, msg(2)), appendInbound(b, msg(3))]);
    expect((await readInbox(a, 100)).map((m) => m.messageId)).toEqual(["m1"]);
    expect((await readInbox(b, 100)).map((m) => m.messageId).sort()).toEqual(["m2", "m3"]);
  });
});

describe("delivery cursors under concurrency — no duplicate user-facing work", () => {
  it("preserves every acknowledgement, reply key, and legacy thread turn", async () => {
    const ackFile = join(dir, "acks.json");
    const replyFile = join(dir, "replies.json");
    const threadFile = join(dir, "threads.json");

    await Promise.all([
      appendAckCursor(ackFile, ["a", "b"]),
      appendAckCursor(ackFile, ["c"]),
      appendReplyCursor(replyFile, ["r1"]),
      appendReplyCursor(replyFile, ["r2", "r3"]),
      appendThreadTurns(threadFile, "telegram:me", [{ content: "first", role: "user" }]),
      appendThreadTurns(threadFile, "telegram:me", [{ content: "second", role: "assistant" }])
    ]);

    expect([...await readAckCursor(ackFile)].sort()).toEqual(["a", "b", "c"]);
    expect([...await readReplyCursor(replyFile)].sort()).toEqual(["r1", "r2", "r3"]);
    expect((await readThread(threadFile, "telegram:me")).map((turn) => turn.content).sort()).toEqual(["first", "second"]);
  });
});

describe("inbox injection cursor under concurrency — no repeated prompt context", () => {
  it("unions equal-timestamp message ids from concurrent advances", async () => {
    const file = join(dir, "injection.json");
    const iso = "2026-07-16T00:00:00.000Z";

    await Promise.all([
      advanceInboxInjectionCursor(file, { telegram: { ids: ["a"], iso } }, "u1"),
      advanceInboxInjectionCursor(file, { telegram: { ids: ["b"], iso } }, "u1")
    ]);

    expect((await readInboxInjectionCursor(file, "u1")).telegram).toEqual({ ids: ["a", "b"], iso });
  });
});

describe("recordPendingApproval under concurrency — no crash / corruption (tmp-name uniqueness fix)", () => {
  const approval = (i: number): PendingApproval => ({
    arguments: {},
    createdAt: "2026-01-01T00:00:00Z",
    draft: "send?",
    expiresAt: "2030-01-01T00:00:00Z",
    id: `p${i}`,
    providerId: "slack",
    risk: "write",
    source: "C1",
    tool: "email_send",
  });

  it("preserves EVERY record when many fire at once (per-file write-queue, lossless)", async () => {
    // Regression history: (1) the tmp file was `${pid}-${Date.now()}` so same-ms
    // writes collided -> ENOENT crash; (2) even fixed, the read-modify-write was
    // last-writer-wins and silently dropped records. A per-file mutation queue
    // serialises the whole op, so a refused action's pending approval is never
    // lost.
    const file = join(dir, "pending.json");
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_v, i) => recordPendingApproval(file, approval(i))));
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect((await readPendingApprovals(file)).map((p) => p.id).sort()).toEqual(Array.from({ length: 25 }, (_v, i) => `p${i}`).sort());
  });

  it("serialises concurrent clears + records correctly (cleared gone, new kept)", async () => {
    const file = join(dir, "mixed.json");
    for (let i = 0; i < 10; i += 1) await recordPendingApproval(file, approval(i));
    await Promise.all([
      clearPendingApproval(file, "p0"),
      clearPendingApproval(file, "p1"),
      recordPendingApproval(file, approval(100)),
      clearPendingApproval(file, "p2"),
    ]);
    const ids = (await readPendingApprovals(file)).map((p) => p.id);
    expect(ids).not.toContain("p0");
    expect(ids).not.toContain("p1");
    expect(ids).not.toContain("p2");
    expect(ids).toContain("p100");
    expect(ids).toHaveLength(8); // 10 - 3 cleared + 1 added
  });

  it("persists every record when calls are sequential (await each)", async () => {
    const file = join(dir, "seq.json");
    for (let i = 0; i < 10; i += 1) await recordPendingApproval(file, approval(i));
    expect((await readPendingApprovals(file)).map((p) => p.id).sort()).toEqual(Array.from({ length: 10 }, (_v, i) => `p${i}`).sort());
  });

  it("grants exactly one claim across independent processes and a fresh reload", async () => {
    const file = join(dir, "cross-process-claim.json");
    await recordPendingApproval(file, approval(77));
    const root = join(process.cwd(), "../..");
    const tsx = join(root, "node_modules", ".bin", "tsx");
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "pending-approval-store.ts")).href;
    const script = `import { claimPendingApproval } from ${JSON.stringify(moduleUrl)}; void (async () => { const result = await claimPendingApproval(process.argv[1], "p77", { surface: "cli" }); process.stdout.write(JSON.stringify(result)); })();`;

    const outcomes = await Promise.all([
      execFileAsync(tsx, ["--eval", script, file], { cwd: process.cwd() }),
      execFileAsync(tsx, ["--eval", script, file], { cwd: process.cwd() })
    ]);
    const claims = outcomes.map(({ stdout }) => JSON.parse(stdout) as { claimedByThisCall: boolean; state: string });
    expect(claims.filter((claim) => claim.claimedByThisCall)).toHaveLength(1);
    expect(claims.map((claim) => claim.state)).toEqual(["claimed", "claimed"]);
    expect(await claimPendingApproval(file, "p77", { surface: "cli" })).toEqual({ claimedByThisCall: false, state: "claimed" });
  });

  it("keeps an executing tombstone when the terminal atomic write fails", async () => {
    const file = join(dir, "finalize-failure", "pending.json");
    await recordPendingApproval(file, approval(88));
    const claim = await claimPendingApproval(file, "p88", { surface: "cli" });
    if (!claim.claimedByThisCall) throw new Error("expected claim");
    expect((await beginPendingApprovalExecution(file, "p88", claim.claimToken)).transitioned).toBe(true);

    const parent = join(dir, "finalize-failure");
    await fs.chmod(parent, 0o500);
    try {
      await expect(finalizePendingApprovalExecution(file, "p88", claim.claimToken, "succeeded")).rejects.toThrow();
    } finally {
      await fs.chmod(parent, 0o700);
    }

    expect(await claimPendingApproval(file, "p88", { surface: "cli" })).toEqual({ claimedByThisCall: false, state: "executing" });
  });
});
